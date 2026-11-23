import {
  AtelierError,
  addCardLog,
  addDays,
  computeCustomerBalance,
  computeOrderBillingBreakdown,
  ensureOrderInvoices,
  getFullName,
  getMemberName,
  getOrderTvaMultiplier,
  getStore,
  isWorkerRole,
  nextId,
  notifyMember,
  nowDateTime,
  num,
  parseJsonArg,
  round2,
  saveStore,
  syncOrderTotals,
  todayISO,
} from '../store.ts';
import { OrderInvoiceRecord, OrderLine, OrderRecord, UserAccount } from '../types.ts';

function getDeliverColId(): string {
  const s = getStore();
  const col = s.board.columns.find((c) => c.deliver);
  return col ? col.id : s.board.columns[s.board.columns.length - 1]?.id || 'delivered';
}

function getStatusIds(order: OrderRecord): string[] {
  if (Array.isArray(order.statuses)) return order.statuses;
  return order.status_id ? [order.status_id] : [];
}

function normalizeStatusIds(raw: any): string[] {
  const s = getStore();
  const valid = new Set(s.board.statuses.map((x) => x.id));
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr
    .map((x) => {
      if (typeof x === 'string' && valid.has(x)) return x;
      if (x && typeof x === 'object' && valid.has(x.id)) return x.id;
      const byName = s.board.statuses.find((st) => st.name === x);
      return byName ? byName.id : null;
    })
    .filter((x): x is string => Boolean(x));
}

function orderUsesMaterials(order: OrderRecord): boolean {
  const s = getStore();
  return order.lines.some((l) => {
    const srv = s.services.find((x) => x.item_code === l.item_code);
    return srv && srv.recipe && srv.recipe.length > 0;
  });
}

function formatCardRow(o: OrderRecord, worker: boolean) {
  const s = getStore();
  const commentCount = s.comments.filter(
    (c) => c.reference_doctype === 'Sales Order' && c.reference_name === o.name && c.comment_type === 'Comment'
  ).length;
  const fileCount = s.files.filter(
    (f) => f.attached_to_doctype === 'Sales Order' && f.attached_to_name === o.name
  ).length;
  const doneChecks = (o.checklist || []).filter((c) => c.done).length;
  return {
    name: o.name,
    title: o.title || o.name,
    customer: o.customer,
    customer_name: o.customer_name,
    column: o.column,
    labels: o.labels || [],
    members: o.members || [],
    due: o.delivery_date,
    due_time: o.due_time,
    cover: o.cover,
    pos: o.pos,
    grand_total: worker ? null : o.grand_total,
    paid: worker ? null : o.paid,
    price_pending: o.price_pending,
    docstatus: o.docstatus,
    per_delivered: o.per_delivered,
    comments: commentCount,
    files: fileCount,
    check: [doneChecks, (o.checklist || []).length],
    status: getStatusIds(o),
    cover_color: o.cover_color,
  };
}

function formatCardLines(o: OrderRecord, worker: boolean) {
  return o.lines.map((l, idx) => ({
    idx: l.idx || idx + 1,
    item_code: l.item_code,
    item_name: l.item_name,
    text: l.description || l.item_name,
    item_group: l.item_group || '',
    category: l.item_group || '',
    description: l.description || l.item_name,
    qty: l.qty,
    pieces: l.pieces ?? l.qty,
    uom: l.uom,
    unit: l.atelier_unit || l.uom,
    atelier_unit: l.atelier_unit || l.uom,
    size: l.size || '',
    width: l.width ?? null,
    height: l.height ?? null,
    length: l.length ?? null,
    rate: worker ? null : l.price_pending ? null : l.rate,
    amount: worker ? null : l.price_pending ? null : l.amount,
    price_pending: l.price_pending,
    delivered_qty: l.delivered_qty || 0,
    material: l.material || '',
    per: l.per_sheet ?? 1,
    per_sheet: l.per_sheet ?? null,
  }));
}

function createOrderInvoice(
  order: OrderRecord,
  netAmount: number,
  grandAmount: number,
  postingDate: string
): OrderInvoiceRecord | null {
  const grand = round2(grandAmount);
  const net = round2(netAmount);
  if (grand <= 0.005) return null;
  const s = getStore();
  const invs = ensureOrderInvoices(order);
  order.invoices = invs;

  // Auto-deduct any unallocated advance already paid on this order (including advances made while price_pending)
  const alreadyApplied = round2(
    invs.filter((i) => !i.is_return).reduce((a, i) => a + i.paid_amount, 0)
  );
  const unallocated = round2(Math.max(0, order.paid - alreadyApplied));
  const applied = round2(Math.min(grand, unallocated));

  const inv: OrderInvoiceRecord = {
    name: nextId('SI'),
    posting_date: postingDate,
    due_date: addDays(postingDate, s.docs.payment_days || 15),
    net_total: net,
    grand_total: grand,
    paid_amount: applied,
    outstanding_amount: round2(Math.max(0, grand - applied)),
  };
  order.invoices.push(inv);
  order.invoice_name = inv.name;
  order.invoiced_date = postingDate;

  const billedGross = round2(
    order.invoices.filter((i) => !i.is_return).reduce((a, i) => a + i.grand_total, 0) -
      order.invoices.filter((i) => i.is_return).reduce((a, i) => a + Math.abs(i.grand_total), 0)
  );
  order.per_billed =
    order.grand_total > 0
      ? Math.min(100, Math.round((billedGross / order.grand_total) * 100))
      : 100;
  return inv;
}

function deliverOrderInternal(order: OrderRecord, user: UserAccount) {
  if (order.per_delivered >= 100) return;
  if (order.price_pending || order.docstatus === 0) {
    throw new AtelierError('حدد سعر الطلب قبل تسليمه');
  }
  const today = todayISO();
  order.per_delivered = 100;
  order.delivered_date = today;
  order.delivery_note = order.delivery_note || nextId('DN');
  for (const l of order.lines) {
    l.delivered_qty = l.qty;
  }
  if (!order.price_pending && order.grand_total > 0) {
    const br = computeOrderBillingBreakdown(order);
    if (br.unbilledTotal > 0.005) {
      const mult = getOrderTvaMultiplier(order.customer);
      const remNet = round2(br.unbilledTotal / mult);
      createOrderInvoice(order, remNet, br.unbilledTotal, today);
    }
    order.per_billed = 100;
    order.invoiced_date = order.invoiced_date || today;
    order.invoice_name = order.invoice_name || nextId('SI');
    order.status = 'Completed';
  } else {
    order.status = 'To Bill';
  }
  order.docstatus = 1;
  order.column = getDeliverColId();
  order.modified = nowDateTime();
  addCardLog(order.name, 'تم تسليم الطلب وإصدار الوثائق', user.email, 'Info');
}

function makeOrderLine(raw: any, idx: number, customerType: string): OrderLine {
  const s = getStore();
  const srv =
    s.services.find((x) => x.item_code === raw.item_code) ||
    s.services.find((x) => x.item_name === (raw.item_name || raw.text));
  const unitName = raw.unit || raw.atelier_unit || raw.uom || srv?.stock_uom || 'قطعة';
  const unitDef = s.units.find((u) => u.name === unitName);
  const w = raw.width != null && raw.width !== '' ? num(raw.width, 0) : 0;
  const h = raw.height != null && raw.height !== '' ? num(raw.height, 0) : 0;
  const len = raw.length != null && raw.length !== '' ? num(raw.length, 0) : 0;
  const pieces = Math.max(1, num(raw.pieces ?? raw.qty, 1));
  let qty = Math.max(0.001, num(raw.qty, 1));
  if (unitDef?.calc === 'area' && w > 0 && h > 0) {
    qty = round2(w * h * pieces);
  } else if (unitDef?.calc === 'length' && len > 0) {
    qty = round2(len * pieces);
  }
  const hasRate = raw.rate !== undefined && raw.rate !== null && raw.rate !== '';
  const defaultRate = srv
    ? customerType === 'Company'
      ? srv.price_company ?? srv.price_individual ?? srv.standard_rate
      : srv.price_individual ?? srv.price_company ?? srv.standard_rate
    : null;
  const pricePending = raw.price_pending ? 1 : !hasRate && defaultRate === null ? 1 : 0;
  const rate = pricePending ? null : num(hasRate ? raw.rate : defaultRate, 0);
  const label = raw.text || raw.item_name || srv?.item_name || raw.description || 'خدمة طباعة';
  const sizeStr = raw.size || raw.atelier_size || (w > 0 && h > 0 ? `${w}×${h}` : len > 0 ? `${len}` : '');
  return {
    idx,
    item_code: srv?.item_code || raw.item_code || 'SRV-GENERAL',
    item_name: raw.item_name || srv?.item_name || label,
    item_group: raw.category || srv?.item_group || raw.item_group || 'طباعة رقمية',
    description: raw.description || label,
    qty,
    pieces,
    uom: unitName,
    atelier_unit: unitName,
    size: sizeStr,
    width: w || null,
    height: h || null,
    length: len || null,
    rate,
    amount: rate !== null ? round2(qty * rate) : null,
    price_pending: pricePending,
    delivered_qty: num(raw.delivered_qty, 0),
    material: raw.material || raw.atelier_material || '',
    per_sheet: raw.per ?? raw.per_sheet ? num(raw.per ?? raw.per_sheet) : null,
  };
}

export const boardHandlers: Record<string, (args: Record<string, any>, user: UserAccount) => any> = {
  board(_args, user) {
    return boardHandlers.board2(_args, user);
  },

  board2(_args, user) {
    const s = getStore();
    const worker = isWorkerRole(user.role);
    const me = getMemberName(user.email);

    const cards = s.orders
      .filter((o) => o.docstatus < 2 && !o.archived)
      .filter((o) => !worker || (me && o.members.includes(me)))
      .sort((a, b) => (a.pos || 0) - (b.pos || 0))
      .map((o) => formatCardRow(o, worker));

    return {
      config: s.board,
      cards,
      manager: user.role === 'manager',
      worker,
      me,
      calendar: s.calendar,
    };
  },

  orders(args, user) {
    const s = getStore();
    const worker = isWorkerRole(user.role);
    const me = getMemberName(user.email);
    const q = String(args.q || '').trim().toLowerCase();

    return s.orders
      .filter((o) => o.docstatus < 2 && !o.archived)
      .filter((o) => !worker || (me && o.members.includes(me)))
      .filter(
        (o) =>
          !q ||
          o.name.toLowerCase().includes(q) ||
          o.title.toLowerCase().includes(q) ||
          o.customer_name.toLowerCase().includes(q)
      )
      .sort((a, b) => b.creation.localeCompare(a.creation))
      .map((o) => ({
        name: o.name,
        atelier_subject: o.title,
        title: o.title,
        customer: o.customer,
        customer_name: o.customer_name,
        transaction_date: o.transaction_date,
        delivery_date: o.delivery_date,
        column: o.column,
        status: o.status,
        grand_total: worker ? null : o.grand_total,
        paid: worker ? null : o.paid,
        price_pending: o.price_pending,
        per_delivered: o.per_delivered,
        per_billed: o.per_billed,
        docstatus: o.docstatus,
        tags: o.tags,
        members: o.members,
      }));
  },

  card(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const worker = isWorkerRole(user.role);
    const me = getMemberName(user.email);
    if (worker && (!me || !o.members.includes(me))) {
      throw new AtelierError('هذه البطاقة ليست مسندة إليك', 403);
    }
    const cust = s.customers.find((c) => c.name === o.customer);
    const bal = cust ? computeCustomerBalance(cust.name) : { balance: 0 };
    const client = {
      name: o.customer,
      customer_name: o.customer_name,
      type: cust?.customer_type || 'Individual',
      customer_type: cust?.customer_type || 'Individual',
      mobile: cust?.mobile_no || '',
      phone: cust?.mobile_no || '',
      mobile_no: cust?.mobile_no || '',
      email_id: cust?.email_id || '',
      owes: worker ? 0 : bal.balance,
      vip: cust?.vip || 0,
      note: cust?.note || '',
    };

    const files = s.files
      .filter((f) => f.attached_to_doctype === 'Sales Order' && f.attached_to_name === o.name)
      .map((f) => ({ ...f, by: getFullName(f.owner) }));

    const activity = s.comments
      .filter((c) => c.reference_doctype === 'Sales Order' && c.reference_name === o.name)
      .slice(0, 100)
      .map((c) => ({ ...c, by: getFullName(c.owner) }));

    const folderPath = s.folders.enabled
      ? `${s.folders.root}\\${o.customer_name}\\${o.name}`
      : null;

    const lockedReasons: string[] = [];
    if (o.per_delivered >= 100) lockedReasons.push('تم تسليم الطلب');
    if (o.per_billed >= 100) lockedReasons.push('تمت فوترة الطلب');

    return {
      name: o.name,
      title: o.title || o.name,
      customer: o.customer,
      customer_name: o.customer_name,
      column: o.column,
      labels: o.labels || [],
      members: o.members || [],
      due: o.delivery_date,
      due_time: o.due_time,
      description: o.description || '',
      checklist: o.checklist || [],
      client,
      cover: o.cover,
      cover_color: o.cover_color,
      final: o.final,
      status: getStatusIds(o),
      files,
      activity,
      folder: folderPath,
      grand_total: worker ? null : o.grand_total,
      paid: worker ? null : o.paid,
      price_pending: o.price_pending,
      docstatus: o.docstatus,
      per_delivered: o.per_delivered,
      can_edit: true,
      can_delete: !worker && o.per_delivered < 100 && o.paid <= 0,
      lines: formatCardLines(o, worker),
      lines_locked: lockedReasons,
      money: !worker,
      materials_pending: Boolean(o.per_delivered >= 100 && !o.materials_done && orderUsesMaterials(o)),
      outsourced: o.outsourced,
      invoice_name: o.invoice_name,
      delivery_note: o.delivery_note,
    };
  },

  add_card(args, user) {
    const s = getStore();
    const title = String(args.title || '').trim();
    if (!title) throw new AtelierError('اكتب عنوان البطاقة');
    const col = s.board.columns.find((c) => c.id === args.column);
    if (!col || col.deliver) throw new AtelierError('أضف البطاقة في عمود عمل');

    const cashCust = s.customers.find((c) => c.name === 'CUS-CASH') || s.customers[0];
    const name = nextId('SO');
    const now = nowDateTime();
    const order: OrderRecord = {
      name,
      title,
      customer: cashCust.name,
      customer_name: cashCust.customer_name,
      transaction_date: todayISO(),
      delivery_date: addDays(todayISO(), 3),
      due_time: null,
      column: col.id,
      status_id: null,
      labels: [],
      tags: [],
      members: [],
      description: '',
      checklist: [],
      cover: null,
      cover_color: null,
      final: null,
      pos: (s.orders.length + 1) * 10,
      lines: [
        {
          idx: 1,
          item_code: 'SRV-GENERAL',
          item_name: title,
          description: title,
          qty: 1,
          uom: 'خدمة',
          atelier_unit: 'خدمة',
          rate: null,
          amount: null,
          price_pending: 1,
          delivered_qty: 0,
        },
      ],
      grand_total: 0,
      net_total: 0,
      paid: 0,
      price_pending: 1,
      docstatus: 0,
      status: 'Draft',
      per_delivered: 0,
      per_billed: 0,
      delivered_date: null,
      invoiced_date: null,
      invoice_name: null,
      delivery_note: null,
      archived: 0,
      materials_done: 0,
      outsourced: 0,
      cost_lines: [],
      creation: now,
      modified: now,
      owner: user.email,
    };
    s.orders.unshift(order);
    addCardLog(name, `أنشأ البطاقة في «${col.name}»`, user.email, 'Info');
    saveStore();
    return name;
  },

  quick_order(args, user) {
    const s = getStore();
    const d = parseJsonArg<any>(args.data ?? args, {});
    const customerId = d.customer;
    let cust = customerId ? s.customers.find((c) => c.name === customerId || c.customer_name === customerId) : undefined;
    if (!cust && d.new_customer?.name) {
      const nc = d.new_customer;
      cust = {
        name: `CUS-${String(s.customers.length + 1).padStart(3, '0')}`,
        customer_name: String(nc.name).trim(),
        customer_type: nc.type === 'Company' ? 'Company' : 'Individual',
        relation: nc.type === 'Company' ? 'company' : 'final',
        contact_person: '',
        mobile_no: String(nc.phone || ''),
        email_id: '',
        address: '',
        city: '',
        notes: '',
        note: '',
        vip: 0,
        disabled: 0,
        tax_id: '',
        rc: '',
        nis: '',
        ai: '',
        credit_limit: 0,
        tva_exempt: 0,
        tags: [],
        contacts: [],
        opening_balance: 0,
        creation: todayISO(),
      };
      s.customers.push(cust);
    }
    if (!cust) {
      cust = s.customers.find((c) => c.name === 'CUS-CASH') || s.customers[0];
    }

    const colId = d.column && s.board.columns.some((c) => c.id === d.column)
      ? d.column
      : s.board.columns.find((c) => !c.deliver)?.id || 'new';
    const col = s.board.columns.find((c) => c.id === colId);

    const rawLines = Array.isArray(d.lines) && d.lines.length
      ? d.lines
      : [
          {
            item_code: d.item_code || 'SRV-GENERAL',
            item_name: d.what || d.subject || d.title || 'طلب طباعة',
            description: d.what || d.subject || d.title || 'طلب طباعة',
            qty: num(d.qty, 1),
            uom: d.uom || 'خدمة',
            rate: d.price !== undefined && d.price !== null && d.price !== '' ? num(d.price) : null,
            price_pending: d.price === undefined || d.price === null || d.price === '' ? 1 : 0,
          },
        ];

    const lines = rawLines.map((l: any, idx: number) => makeOrderLine(l, idx + 1, cust!.customer_type));
    const title = String(d.subject || d.title || d.what || lines[0]?.item_name || 'طلب جديد').trim().slice(0, 140);
    const name = nextId('SO');
    const now = nowDateTime();
    const statuses = normalizeStatusIds(d.status);
    const checklist = Array.isArray(d.checklist)
      ? d.checklist
          .map((item: any) =>
            typeof item === 'string'
              ? { text: item.trim(), done: false }
              : { text: String(item?.text || '').trim(), done: Boolean(item?.done) }
          )
          .filter((x: any) => x.text)
      : [];

    const order: OrderRecord = {
      name,
      title,
      customer: cust.name,
      customer_name: cust.customer_name,
      transaction_date: todayISO(),
      delivery_date: d.delivery_date || d.due || null,
      due_time: d.due_time || null,
      column: colId,
      status_id: statuses[0] || null,
      statuses,
      labels: Array.isArray(d.labels) ? d.labels : [],
      tags: Array.isArray(d.tags) ? d.tags : [],
      members: Array.isArray(d.members) ? d.members : d.assignee ? [d.assignee] : [],
      description: String(d.description || ''),
      checklist,
      cover: d.cover || null,
      cover_color: d.cover_color || null,
      final: null,
      pos: 5,
      lines,
      grand_total: 0,
      net_total: 0,
      paid: 0,
      price_pending: 0,
      docstatus: 1,
      status: 'To Deliver and Bill',
      per_delivered: 0,
      per_billed: 0,
      delivered_date: null,
      invoiced_date: null,
      invoice_name: null,
      delivery_note: null,
      archived: 0,
      materials_done: 0,
      outsourced: 0,
      cost_lines: [],
      creation: now,
      modified: now,
      owner: user.email,
    };

    syncOrderTotals(order);
    if (order.price_pending) {
      order.docstatus = 0;
      order.status = 'Draft';
    }

    const advance = round2(num(d.advance ?? d.paid, 0));
    if (advance < 0) {
      throw new AtelierError('التسبيق لا يكون سالبًا');
    }
    if (!order.price_pending && advance > order.grand_total + 0.005) {
      throw new AtelierError(`التسبيق أكبر من مبلغ الطلب شامل الضريبة (${order.grand_total})`);
    }

    const mode = d.mode_of_payment || d.mode || 'Cash';
    if (advance > 0 && !s.modes.some((m) => m.value === mode)) {
      throw new AtelierError('طريقة الدفع غير صالحة');
    }

    s.orders.unshift(order);

    if (advance > 0) {
      const modeObj = s.modes.find((m) => m.value === mode) || s.modes[0];
      const salesFund = user.role === 'sales' ? s.funds.find((f) => f.user === user.email) : null;
      const account = mode === 'Cash' && salesFund ? salesFund.name : modeObj?.account || 'CASH-MAIN';
      s.payments.unshift({
        name: nextId('PE'),
        posting_date: todayISO(),
        creation: now,
        payment_type: 'Receive',
        party_type: 'Customer',
        party: cust.name,
        party_name: cust.customer_name,
        amount: advance,
        mode_of_payment: mode,
        account,
        sales_order: name, // Always linked to order (even if price_pending/draft) so invoice_order deducts it automatically
        clearance_date: mode === 'Cheque' ? null : todayISO(),
        unallocated_amount: advance,
        owner: user.email,
        note: `تسبيق عند إنشاء الطلب ${name}`,
      });
      syncOrderTotals(order);
    }

    addCardLog(name, `أنشأ الطلب في «${col?.name || colId}»`, user.email, 'Info');
    for (const m of order.members) {
      notifyMember(m, name, `${user.full_name} أسندك إلى «${order.title}»`);
    }
    saveStore();
    return { sales_order: name, name, grand_total: order.grand_total, paid: order.paid };
  },

  move(args, user) {
    return boardHandlers.move_card(args, user);
  },

  move_card(args, user) {
    const s = getStore();
    const col = s.board.columns.find((c) => c.id === args.column);
    if (!col) throw new AtelierError('عمود غير معروف');
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    if (o.column === col.id) return col.id;
    if (o.per_delivered >= 100 && !col.deliver) {
      throw new AtelierError('هذا الطلب سُلّم ولا يمكن إرجاعه');
    }
    if (col.deliver) {
      deliverOrderInternal(o, user);
    } else {
      o.column = col.id;
      o.modified = nowDateTime();
      addCardLog(o.name, `نقل البطاقة إلى «${col.name}»`, user.email, 'Info');
    }
    saveStore();
    return col.id;
  },

  update_card(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const ch = parseJsonArg<Record<string, any>>(args.changes, {});

    if ('title' in ch) {
      const t = String(ch.title || '').trim().slice(0, 140);
      if (!t) throw new AtelierError('العنوان لا يكون فارغًا');
      o.title = t;
    }
    if ('customer' in ch && ch.customer) {
      const c = s.customers.find((x) => x.name === ch.customer);
      if (c) {
        o.customer = c.name;
        o.customer_name = c.customer_name;
      }
    }
    if ('labels' in ch) {
      const valid = new Set(s.board.labels.map((l) => l.id));
      o.labels = (ch.labels || []).filter((id: string) => valid.has(id));
    }
    if ('status' in ch) {
      const nextSt = normalizeStatusIds(ch.status);
      o.statuses = nextSt;
      o.status_id = nextSt[0] || null;
    }
    if ('members' in ch) {
      const prev = new Set(o.members);
      o.members = (ch.members || []).filter(Boolean).slice(0, 10);
      for (const m of o.members) {
        if (!prev.has(m)) notifyMember(m, o.name, `${user.full_name} أسندك إلى «${o.title}»`);
      }
    }
    if ('description' in ch) {
      o.description = String(ch.description || '').slice(0, 5000);
    }
    if ('checklist' in ch) {
      o.checklist = Array.isArray(ch.checklist)
        ? ch.checklist.map((item: any) => ({ text: String(item.text || ''), done: Boolean(item.done) }))
        : [];
    }
    if ('due' in ch) {
      o.delivery_date = ch.due || null;
    }
    if ('due_time' in ch) {
      o.due_time = ch.due_time || null;
    }
    if ('cover' in ch) {
      o.cover = ch.cover || null;
      if (o.cover) o.cover_color = null;
    }
    if ('cover_color' in ch) {
      o.cover_color = ch.cover_color || null;
      if (o.cover_color) o.cover = null;
    }
    if ('final' in ch) {
      o.final = ch.final || null;
    }
    if ('column' in ch && ch.column && ch.column !== o.column) {
      boardHandlers.move_card({ name: o.name, column: ch.column }, user);
    }

    o.modified = nowDateTime();
    saveStore();
    return boardHandlers.card({ name: o.name }, user);
  },

  update_order(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    if (args.assignee !== undefined) {
      o.members = args.assignee ? [args.assignee] : [];
    }
    if (args.price !== undefined && args.price !== null && args.price !== '') {
      const p = num(args.price);
      if (o.lines.length) {
        o.lines[0].rate = round2(p / Math.max(1, o.lines[0].qty));
        o.lines[0].price_pending = 0;
        syncOrderTotals(o);
      }
    }
    o.modified = nowDateTime();
    saveStore();
    return { ok: true, grand_total: o.grand_total };
  },

  update_lines(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    if (o.per_delivered >= 100 || o.per_billed >= 100) {
      throw new AtelierError('لا يمكن تعديل البنود بعد التسليم أو الفوترة');
    }
    const cust = s.customers.find((c) => c.name === o.customer);
    const rawLines = parseJsonArg<any[]>(args.lines, []);
    if (!rawLines.length) throw new AtelierError('أضف بندًا واحدًا على الأقل');
    o.lines = rawLines.map((l, idx) => makeOrderLine(l, idx + 1, cust?.customer_type || 'Individual'));
    syncOrderTotals(o);
    if (!o.price_pending && o.docstatus === 0) {
      o.docstatus = 1;
      o.status = 'To Deliver and Bill';
    }
    o.modified = nowDateTime();
    addCardLog(o.name, 'حدّث بنود الطلب', user.email, 'Info');
    saveStore();
    return boardHandlers.card({ name: o.name }, user);
  },

  add_comment(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const text = String(args.text || '').trim();
    if (!text) throw new AtelierError('اكتب تعليقًا');
    const cmt = {
      name: nextId('CMT'),
      reference_doctype: 'Sales Order',
      reference_name: o.name,
      comment_type: 'Comment' as const,
      content: text,
      owner: user.email,
      creation: nowDateTime(),
    };
    s.comments.unshift(cmt);
    saveStore();
    return { ...cmt, by: user.full_name };
  },

  file_added(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const exists = s.files.find(
      (f) => f.attached_to_name === o.name && f.file_url === args.file_url
    );
    if (!exists && args.file_url) {
      s.files.unshift({
        name: nextId('FILE'),
        file_name: args.file_name || 'ملف مرفق',
        file_url: args.file_url,
        file_size: 0,
        is_private: 0,
        attached_to_doctype: 'Sales Order',
        attached_to_name: o.name,
        atelier_kind: '',
        creation: nowDateTime(),
        owner: user.email,
      });
    }
    addCardLog(o.name, `أرفق ملفًا: ${args.file_name || ''}`, user.email, 'Info');
    saveStore();
    return { ok: true };
  },

  delete_file(args) {
    const s = getStore();
    const f = s.files.find((x) => x.name === args.file);
    s.files = s.files.filter((x) => x.name !== args.file);
    if (f) {
      const o = s.orders.find((x) => x.name === args.name);
      if (o && o.cover === f.file_url) o.cover = null;
      if (o && o.final === f.file_url) o.final = null;
    }
    saveStore();
    return { ok: true };
  },

  delete_card(args, user) {
    const s = getStore();
    if (isWorkerRole(user.role)) throw new AtelierError('ليست لديك صلاحية الحذف', 403);
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    if (o.per_delivered >= 100 || o.paid > 0) {
      throw new AtelierError('لا يمكن حذف طلب به دفعات أو تسليم؛ استخدم الإلغاء أو الأرشفة');
    }
    s.orders = s.orders.filter((x) => x.name !== o.name);
    saveStore();
    return { ok: true };
  },

  archive_card(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    o.archived = num(args.archived, 1) ? 1 : 0;
    saveStore();
    return { ok: true };
  },

  archive_paid(args) {
    const s = getStore();
    let count = 0;
    for (const o of s.orders) {
      if (
        !o.archived &&
        o.docstatus < 2 &&
        o.column === args.column &&
        !o.price_pending &&
        o.grand_total > 0 &&
        o.paid >= o.grand_total - 0.01
      ) {
        o.archived = 1;
        count++;
      }
    }
    saveStore();
    return { count };
  },

  archived_cards(args) {
    const s = getStore();
    const cancelled = num(args.cancelled, 0);
    return s.orders
      .filter((o) => (cancelled ? o.docstatus === 2 : o.archived === 1 && o.docstatus < 2))
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .map((o) => ({
        name: o.name,
        title: o.title,
        customer: o.customer,
        customer_name: o.customer_name,
        grand_total: o.grand_total,
        paid: o.paid,
        due: o.delivery_date,
        modified: o.modified.slice(0, 10),
        column: o.column,
        status: getStatusIds(o),
      }));
  },

  copy_card(args, user) {
    const s = getStore();
    const src = s.orders.find((x) => x.name === args.name);
    if (!src) throw new AtelierError('الطلب غير موجود', 404);
    const name = nextId('SO');
    const now = nowDateTime();
    const firstCol = s.board.columns.find((c) => !c.deliver)?.id || 'new';
    const copy: OrderRecord = {
      ...JSON.parse(JSON.stringify(src)),
      name,
      title: `${src.title} (نسخة)`,
      transaction_date: todayISO(),
      delivery_date: addDays(todayISO(), 3),
      column: firstCol,
      paid: 0,
      per_delivered: 0,
      per_billed: 0,
      delivered_date: null,
      invoiced_date: null,
      invoice_name: null,
      delivery_note: null,
      archived: 0,
      materials_done: 0,
      docstatus: src.price_pending ? 0 : 1,
      status: src.price_pending ? 'Draft' : 'To Deliver and Bill',
      checklist: src.checklist.map((c) => ({ text: c.text, done: false })),
      creation: now,
      modified: now,
      owner: user.email,
    };
    for (const l of copy.lines) l.delivered_qty = 0;
    s.orders.unshift(copy);
    addCardLog(name, `نسخة من الطلب ${src.name}`, user.email, 'Info');
    saveStore();
    return name;
  },

  reorder(args) {
    const s = getStore();
    const names = parseJsonArg<string[]>(args.names, []);
    names.forEach((n, idx) => {
      const o = s.orders.find((x) => x.name === n);
      if (o) {
        if (args.column) o.column = args.column;
        o.pos = (idx + 1) * 10;
      }
    });
    saveStore();
    return { ok: true };
  },

  reorder_card(args, user) {
    const s = getStore();
    const src = s.orders.find((x) => x.name === args.name);
    if (!src) throw new AtelierError('الطلب غير موجود', 404);
    const name = nextId('SO');
    const now = nowDateTime();
    const firstCol = s.board.columns.find((c) => !c.deliver)?.id || 'new';
    const copy: OrderRecord = {
      ...JSON.parse(JSON.stringify(src)),
      name,
      transaction_date: todayISO(),
      delivery_date: addDays(todayISO(), 3),
      column: firstCol,
      paid: 0,
      per_delivered: 0,
      per_billed: 0,
      delivered_date: null,
      invoiced_date: null,
      invoice_name: null,
      delivery_note: null,
      archived: 0,
      materials_done: 0,
      docstatus: src.price_pending ? 0 : 1,
      status: src.price_pending ? 'Draft' : 'To Deliver and Bill',
      checklist: src.checklist.map((c) => ({ text: c.text, done: false })),
      creation: now,
      modified: now,
      owner: user.email,
    };
    for (const l of copy.lines) l.delivered_qty = 0;
    s.orders.unshift(copy);
    addCardLog(name, `إعادة طلب من ${src.name}`, user.email, 'Info');
    saveStore();
    return name;
  },

  save_board(args, user) {
    const s = getStore();
    if (user.role !== 'manager') throw new AtelierError('التخصيص للمدير فقط', 403);
    const cfg = parseJsonArg<any>(args.config, {});
    const moves = parseJsonArg<Record<string, string>>(args.moves, {});
    const cols = Array.isArray(cfg.columns) ? cfg.columns : s.board.columns;
    const labels = Array.isArray(cfg.labels) ? cfg.labels : s.board.labels;
    const statuses = Array.isArray(cfg.statuses) ? cfg.statuses : s.board.statuses;
    if (!cols.length) throw new AtelierError('أبقِ عمودًا واحدًا على الأقل');

    const ids = new Set(cols.map((c: any) => c.id));
    const fallback = cols.find((c: any) => !c.deliver)?.id || cols[0].id;
    for (const o of s.orders) {
      if (!ids.has(o.column)) {
        o.column = moves[o.column] && ids.has(moves[o.column]) ? moves[o.column] : fallback;
      }
    }
    s.board = { columns: cols, labels, statuses };
    saveStore();
    return s.board;
  },

  save_board_tag(args, user) {
    const s = getStore();
    if (user.role !== 'manager') throw new AtelierError('التخصيص للمدير فقط', 403);
    const kind = args.kind as 'labels' | 'statuses';
    if (kind !== 'labels' && kind !== 'statuses') throw new AtelierError('نوع غير معروف');
    const name = String(args.name || '').trim().slice(0, 60);
    if (!name) throw new AtelierError('اكتب الاسم');
    const rows = [...s.board[kind]];
    const hit = args.id ? rows.find((x) => x.id === args.id) : null;
    if (hit) {
      hit.name = name;
      if (args.color) hit.color = args.color;
    } else {
      rows.push({
        id: `${kind === 'labels' ? 'lb' : 'st'}-${Date.now().toString(36)}`,
        name,
        color: args.color || '#0F4C81',
      });
    }
    s.board[kind] = rows;
    saveStore();
    return s.board;
  },

  delete_board_tag(args, user) {
    const s = getStore();
    if (user.role !== 'manager') throw new AtelierError('التخصيص للمدير فقط', 403);
    const kind = args.kind as 'labels' | 'statuses';
    if (kind !== 'labels' && kind !== 'statuses') throw new AtelierError('نوع غير معروف');
    s.board[kind] = s.board[kind].filter((x) => x.id !== args.id);
    saveStore();
    return s.board;
  },

  set_tags(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    o.tags = parseJsonArg<string[]>(args.tags, []);
    saveStore();
    return o.tags;
  },

  partial_info(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    return {
      name: o.name,
      title: o.title,
      lines: o.lines.map((l) => ({
        idx: l.idx,
        item_code: l.item_code,
        item_name: l.item_name,
        qty: l.qty,
        delivered: l.delivered_qty || 0,
        remaining: Math.max(0, round2(l.qty - (l.delivered_qty || 0))),
        uom: l.uom,
      })),
    };
  },

  partial_deliver(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    if (o.price_pending || o.docstatus !== 1) {
      throw new AtelierError('حدد سعر الطلب قبل تسليمه');
    }
    const qtys = parseJsonArg<Record<string, number>>(args.qtys, {});
    let totalQty = 0;
    let totalDel = 0;
    let sliceNet = 0;
    let addedAny = false;
    for (const l of o.lines) {
      const remaining = Math.max(0, round2(l.qty - (l.delivered_qty || 0)));
      const reqAdd = num(qtys[String(l.idx)] ?? qtys[l.item_code], 0);
      const add = Math.min(remaining, Math.max(0, round2(reqAdd)));
      if (add > 0) {
        l.delivered_qty = round2((l.delivered_qty || 0) + add);
        sliceNet = round2(sliceNet + add * num(l.rate, 0));
        addedAny = true;
      }
      totalQty += l.qty;
      totalDel += l.delivered_qty || 0;
    }
    if (!addedAny) {
      throw new AtelierError('أدخل كمية واحدة على الأقل للتسليم');
    }
    const today = todayISO();
    const mult = getOrderTvaMultiplier(o.customer);
    const sliceGrand = round2(sliceNet * mult);
    const inv = createOrderInvoice(o, sliceNet, sliceGrand, today);

    o.per_delivered = totalQty > 0 ? Math.min(100, Math.round((totalDel / totalQty) * 100)) : 100;
    o.delivery_note = nextId('DN');
    if (o.per_delivered >= 100) {
      o.delivered_date = today;
      o.per_billed = 100;
      o.status = 'Completed';
      o.column = getDeliverColId();
      addCardLog(o.name, `اكتمل تسليم الطلب وإصدار الفاتورة ${inv?.name || ''}`, user.email, 'Info');
    } else {
      addCardLog(
        o.name,
        `تسليم جزئي (${o.per_delivered}%) — فاتورة ${inv?.name || ''} بمبلغ ${sliceGrand} دج`,
        user.email,
        'Info'
      );
    }
    o.modified = nowDateTime();
    saveStore();
    return {
      per_delivered: o.per_delivered,
      per_billed: o.per_billed,
      delivery_note: o.delivery_note,
      invoice: inv?.name || null,
    };
  },

  cancel_info(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    return {
      name: o.name,
      title: o.title,
      paid: o.paid,
      grand_total: o.grand_total,
      delivered: o.per_delivered > 0,
      can_cancel: true,
    };
  },

  cancel_order(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    if (o.paid > 0 && args.refund_mode) {
      const modeObj = s.modes.find((m) => m.value === args.refund_mode) || s.modes[0];
      s.payments.unshift({
        name: nextId('PE'),
        posting_date: todayISO(),
        creation: nowDateTime(),
        payment_type: 'Pay',
        party_type: 'Customer',
        party: o.customer,
        party_name: o.customer_name,
        amount: o.paid,
        mode_of_payment: args.refund_mode,
        account: modeObj?.account || 'CASH-MAIN',
        sales_order: o.name,
        owner: user.email,
        note: `استرداد عند إلغاء الطلب ${o.name}: ${args.reason || ''}`,
      });
      o.paid = 0;
    }
    o.docstatus = 2;
    o.status = 'Cancelled';
    o.archived = 2;
    o.modified = nowDateTime();
    addCardLog(o.name, `ألغى الطلب${args.reason ? ': ' + args.reason : ''}`, user.email, 'Info');
    saveStore();
    return { ok: true };
  },

  return_info(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    return {
      name: o.name,
      title: o.title,
      paid: o.paid,
      lines: o.lines.map((l) => ({
        idx: l.idx,
        item_code: l.item_code,
        item_name: l.item_name,
        qty: l.delivered_qty || l.qty,
        rate: l.rate || 0,
        uom: l.uom,
      })),
    };
  },

  create_return(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const qtys = parseJsonArg<Record<string, number>>(args.qtys, {});
    let returnNet = 0;
    for (const l of o.lines) {
      const maxRet = l.delivered_qty > 0 ? l.delivered_qty : l.qty;
      const reqQty = num(qtys[String(l.idx)] ?? qtys[l.item_code], 0);
      if (reqQty <= 0) continue;
      if (reqQty > maxRet + 0.005) {
        throw new AtelierError(`كمية المرتجع تتجاوز الكمية المسلمة للبند «${l.item_name}»`);
      }
      if (l.rate) {
        returnNet = round2(returnNet + reqQty * l.rate);
        l.qty = Math.max(0, round2(l.qty - reqQty));
        l.delivered_qty = Math.min(l.qty, Math.max(0, round2(l.delivered_qty - reqQty)));
      }
    }
    if (returnNet <= 0) {
      throw new AtelierError('اختر بندًا واحدًا على الأقل للمرتجع');
    }
    const mult = getOrderTvaMultiplier(o.customer);
    const returnGrand = round2(returnNet * mult);
    const today = todayISO();

    o.returned_net = round2((o.returned_net || 0) + returnNet);
    o.returned_amount = round2((o.returned_amount || 0) + returnGrand);

    // Record credit note and reduce open invoices FIFO
    const invs = ensureOrderInvoices(o);
    o.invoices = invs;
    const targetInv = invs.find((i) => !i.is_return && i.outstanding_amount > 0.005) || invs.find((i) => !i.is_return);
    const cnName = nextId('SI');
    o.invoices.push({
      name: cnName,
      posting_date: today,
      due_date: today,
      net_total: -returnNet,
      grand_total: -returnGrand,
      paid_amount: 0,
      outstanding_amount: 0,
      is_return: 1,
      return_against: targetInv?.name || o.invoice_name || null,
      reason: String(args.reason || '').trim(),
    });

    let creditLeft = returnGrand;
    for (const inv of o.invoices.filter((i) => !i.is_return && i.outstanding_amount > 0.005)) {
      if (creditLeft <= 0.005) break;
      const cut = round2(Math.min(creditLeft, inv.outstanding_amount));
      inv.outstanding_amount = round2(Math.max(0, inv.outstanding_amount - cut));
      creditLeft = round2(creditLeft - cut);
    }

    syncOrderTotals(o);

    let cashRefunded = 0;
    if (returnGrand > 0 && args.refund_mode) {
      const refundable = round2(Math.min(returnGrand, o.paid));
      if (refundable > 0.005) {
        const modeObj = s.modes.find((m) => m.value === args.refund_mode) || s.modes[0];
        s.payments.unshift({
          name: nextId('PE'),
          posting_date: today,
          creation: nowDateTime(),
          payment_type: 'Pay',
          party_type: 'Customer',
          party: o.customer,
          party_name: o.customer_name,
          amount: refundable,
          mode_of_payment: args.refund_mode,
          account: modeObj?.account || 'CASH-MAIN',
          sales_order: o.name,
          invoice: cnName,
          clearance_date: args.refund_mode === 'Cheque' ? null : today,
          owner: user.email,
          note: `مرتجع / إشعار دائن للطلب ${o.name}: ${args.reason || ''}`,
        });
        cashRefunded = refundable;
        syncOrderTotals(o);
      }
    }
    addCardLog(
      o.name,
      `سجّل مرتجعًا (إشعار دائن ${cnName}) بقيمة ${returnGrand} دج${cashRefunded > 0 ? ` — استرداد ${cashRefunded} دج` : ''}`,
      user.email,
      'Info'
    );
    saveStore();
    return { ok: true, credit_note: cnName, refund: returnGrand, cash_refunded: cashRefunded };
  },

  card_quote(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.order);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const kind = args.kind || 'devis';
    const qtnName = nextId('QTN');
    const url = `/api/method/atelier.api.pdf?doctype=Quotation&name=${encodeURIComponent(o.name)}&kind=${encodeURIComponent(kind)}`;
    return { name: qtnName, url, order: o.name, kind };
  },

  card_cost(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const total = round2(o.cost_lines.reduce((a, l) => a + num(l.amount), 0));
    const sale = o.price_pending ? null : o.net_total || o.grand_total || 0;
    const qty = o.lines.reduce((a, l) => a + num(l.qty, 0), 0) || 1;
    return {
      order: o.name,
      qty,
      waste_percent: 0,
      selling_price: sale,
      sale: sale ?? 0,
      total,
      profit: sale !== null ? round2(sale - total) : null,
      margin: sale && sale > 0 ? Math.round(((sale - total) / sale) * 1000) / 10 : null,
      lines: o.cost_lines.map((l) => ({
        cost_type: l.cost_type,
        description: l.description,
        qty: l.qty,
        rate: l.rate ?? '',
      })),
      cost_types: s.lists.cost_types || [],
    };
  },

  save_card_cost(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const d = parseJsonArg<any>(args.data, {});
    const lines = Array.isArray(d.lines) ? d.lines : Array.isArray(d) ? d : [];
    o.cost_lines = lines
      .filter((l: any) => String(l.description || '').trim())
      .map((l: any) => {
        const qty = num(l.qty, 1);
        const rate = num(l.rate, 0);
        return {
          cost_type: l.cost_type || 'Autre',
          description: String(l.description).trim(),
          qty,
          rate,
          amount: round2(l.amount != null ? num(l.amount) : qty * rate),
        };
      });
    saveStore();
    return boardHandlers.card_cost({ name: o.name }, {} as UserAccount);
  },

  mark_outsourced(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.order);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    o.outsourced = num(args.on, 1) ? 1 : 0;
    addCardLog(o.name, o.outsourced ? 'وُسم كعمل خارجي عند مورد' : 'أُلغي وسم العمل الخارجي', user.email, 'Info');
    saveStore();
    return { outsourced: o.outsourced };
  },

  outsource_cost(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.order);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const amount = num(args.amount, 0);
    if (amount <= 0) throw new AtelierError('المبلغ يجب أن يكون أكبر من صفر');
    o.outsourced = 1;
    o.outsource_amount = amount;
    o.outsource_supplier = args.supplier || null;
    o.cost_lines.push({
      cost_type: 'Sous-traitance',
      description: args.note || `عمل خارجي — ${args.supplier || 'مورد'}`,
      qty: 1,
      rate: amount,
      amount,
    });
    if (args.supplier) {
      const sup = s.suppliers.find((x) => x.name === args.supplier || x.supplier_name === args.supplier);
      if (sup) {
        s.supplier_invoices.unshift({
          name: nextId('PI'),
          supplier: sup.name,
          supplier_name: sup.supplier_name,
          posting_date: todayISO(),
          due_date: addDays(todayISO(), 15),
          grand_total: amount,
          outstanding_amount: amount,
          bill_no: '',
          order_name: o.name,
          what: args.note || o.title,
          account: 'EXP-SUB',
          items: [{ item_name: 'استعانة خارجية', description: args.note || o.title, qty: 1, rate: amount, amount, is_stock: 0 }],
          docstatus: 1,
        });
      }
    }
    addCardLog(o.name, `سجّل تكلفة المورد الخارجي: ${amount} دج`, user.email, 'Info');
    saveStore();
    return { ok: true };
  },

  price_order(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const rates = parseJsonArg<Record<string, number>>(args.rates, {});
    for (const l of o.lines) {
      const r = rates[String(l.idx)] ?? rates[l.item_code];
      if (r !== undefined && r !== null) {
        l.rate = num(r);
        l.price_pending = 0;
      }
    }
    syncOrderTotals(o);
    if (!o.price_pending && o.docstatus === 0) {
      o.docstatus = 1;
      o.status = 'To Deliver and Bill';
    }
    saveStore();
    return { grand_total: o.grand_total };
  },

  confirm_order(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    o.docstatus = 1;
    o.status = 'To Deliver and Bill';
    saveStore();
    return { ok: true };
  },

  deliver_order(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    deliverOrderInternal(o, user);
    saveStore();
    return { name: o.delivery_note };
  },

  invoice_order(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.name);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    if (o.price_pending || o.grand_total <= 0) {
      throw new AtelierError('حدد سعر الطلب قبل إصدار الفاتورة');
    }
    const today = todayISO();
    const br = computeOrderBillingBreakdown(o);
    if (br.unbilledTotal > 0.005) {
      const mult = getOrderTvaMultiplier(o.customer);
      createOrderInvoice(o, round2(br.unbilledTotal / mult), br.unbilledTotal, today);
    }
    o.per_billed = 100;
    o.invoiced_date = o.invoiced_date || today;
    o.invoice_name = o.invoice_name || nextId('SI');
    saveStore();
    return { name: o.invoice_name };
  },
};
