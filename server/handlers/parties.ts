import {
  AtelierError,
  addDays,
  computeCustomerBalance,
  computeSupplierBalance,
  daysBetween,
  ensureFunds,
  ensureOrderInvoices,
  getFullName,
  getStore,
  isWorkerRole,
  nextId,
  nowDateTime,
  num,
  parseJsonArg,
  round2,
  saveStore,
  todayISO,
} from '../store.ts';
import { CustomerRecord, SupplierRecord, UserAccount } from '../types.ts';

function firstOfMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export const partyHandlers: Record<string, (args: Record<string, any>, user: UserAccount) => any> = {
  customers(args, user) {
    if (isWorkerRole(user.role)) throw new AtelierError('ليست لديك صلاحية', 403);
    const s = getStore();
    const includeDisabled = num(args.include_disabled, 0);
    return s.customers
      .filter((c) => includeDisabled || !c.disabled)
      .map((c) => {
        const bal = computeCustomerBalance(c.name);
        const custOrders = s.orders.filter((o) => o.customer === c.name && o.docstatus < 2);
        const lastOrder = custOrders
          .map((o) => o.transaction_date)
          .sort()
          .reverse()[0] || null;
        return {
          name: c.name,
          customer_name: c.customer_name,
          customer_type: c.customer_type,
          relation: c.relation,
          mobile_no: c.mobile_no,
          email_id: c.email_id,
          city: c.city,
          balance: bal.balance,
          last_order: lastOrder,
          disabled: c.disabled,
        };
      });
  },

  customers2(_args, user) {
    if (isWorkerRole(user.role)) throw new AtelierError('ليست لديك صلاحية', 403);
    const s = getStore();
    const month = firstOfMonthISO();
    const today = todayISO();
    const awayDays = s.alerts.away_days || 60;

    const rows = s.customers
      .filter((c) => c.name !== 'CUS-CASH')
      .map((c) => {
        const bal = computeCustomerBalance(c.name);
        const custOrders = s.orders.filter((o) => o.customer === c.name && o.docstatus < 2);
        const openCount = custOrders.filter((o) => !o.archived).length;
        const lastOrder = custOrders.map((o) => o.transaction_date).sort().reverse()[0] || null;
        const covers = custOrders
          .map((o) => o.cover)
          .filter((x): x is string => Boolean(x))
          .slice(0, 3);
        const since = c.creation.slice(0, 10);
        return {
          name: c.name,
          customer_name: c.customer_name,
          customer_type: c.customer_type,
          relation: c.relation,
          mobile_no: c.mobile_no,
          email_id: c.email_id,
          city: c.city,
          balance: bal.balance,
          unbilled: bal.unbilled,
          invoices: bal.invoices,
          covers,
          vip: c.vip,
          tags: c.tags || [],
          disabled: c.disabled,
          orders: openCount,
          last_order: lastOrder,
          since,
          new: since >= month,
          away: Boolean(lastOrder && daysBetween(lastOrder, today) >= awayDays),
        };
      });

    return {
      rows,
      away_days: awayDays,
      customer_tags: s.customer_tags,
      manager: user.role === 'manager',
    };
  },

  customer(args, user) {
    return partyHandlers.customer2(args, user);
  },

  customer2(args, user) {
    if (isWorkerRole(user.role)) throw new AtelierError('ليست لديك صلاحية', 403);
    const s = getStore();
    const c = s.customers.find((x) => x.name === args.name);
    if (!c) throw new AtelierError('العميل غير موجود', 404);
    const bal = computeCustomerBalance(c.name);
    const yearStart = `${new Date().getFullYear()}-01-01`;

    const custOrders = s.orders
      .filter((o) => o.customer === c.name && o.docstatus < 2)
      .sort((a, b) => b.creation.localeCompare(a.creation));

    const colName = (id: string) => s.board.columns.find((x) => x.id === id)?.name || '';
    const statusIds = (o: any): string[] => (Array.isArray(o.statuses) ? o.statuses : o.status_id ? [o.status_id] : []);

    const orders = custOrders.map((o) => ({
      name: o.name,
      title: o.title,
      atelier_subject: o.title,
      transaction_date: o.transaction_date,
      delivery_date: o.delivery_date,
      grand_total: o.grand_total,
      paid: o.paid,
      price_pending: o.price_pending,
      per_delivered: o.per_delivered,
      per_billed: o.per_billed,
      docstatus: o.docstatus,
      cover: o.cover,
      cover_color: o.cover_color,
      final: o.final,
      atelier_column: o.column,
      column: colName(o.column),
      archived: o.archived,
      status: statusIds(o),
      folder: s.folders.enabled ? `${s.folders.root}\\${c.customer_name}\\${o.name}` : null,
      size: o.lines.find((l) => l.size)?.size || null,
      lines: o.lines.slice(0, 4).map((l) => ({
        what: l.item_name,
        group: l.item_group || '',
        qty: l.qty,
        uom: l.uom,
        size: l.size || '',
        rate: l.price_pending ? null : l.rate,
        amount: l.price_pending ? null : l.amount,
      })),
    }));

    const custPayments = s.payments
      .filter((p) => p.party_type === 'Customer' && p.party === c.name)
      .sort((a, b) => b.posting_date.localeCompare(a.posting_date));

    const lastPayment = custPayments.find((p) => p.payment_type === 'Receive')?.posting_date || null;
    const yearPaid = round2(
      custPayments
        .filter((p) => p.payment_type === 'Receive' && p.posting_date >= yearStart)
        .reduce((a, b) => a + b.amount, 0)
    );

    // Ledger entries
    const ledgerRaw: any[] = [];
    for (const op of s.openings) {
      if (!op.reversed && op.kind === 'Customer' && op.target === c.name) {
        ledgerRaw.push({
          posting_date: op.posting_date,
          voucher_type: 'Journal Entry',
          voucher_no: op.name,
          debit: op.amount > 0 ? op.amount : 0,
          credit: op.amount < 0 ? -op.amount : 0,
          remarks: op.remark || 'رصيد افتتاحي',
        });
      }
    }
    for (const o of custOrders) {
      for (const inv of ensureOrderInvoices(o)) {
        const isRet = Boolean(inv.is_return);
        ledgerRaw.push({
          posting_date: inv.posting_date,
          voucher_type: isRet ? 'Credit Note' : 'Sales Invoice',
          voucher_no: inv.name,
          debit: isRet ? 0 : Math.abs(inv.grand_total),
          credit: isRet ? Math.abs(inv.grand_total) : 0,
          against_voucher: o.name,
          remarks: isRet ? `مرتجع — ${o.title}${inv.reason ? ' (' + inv.reason + ')' : ''}` : o.title,
        });
      }
    }
    for (const p of custPayments) {
      ledgerRaw.push({
        posting_date: p.posting_date,
        voucher_type: 'Payment Entry',
        voucher_no: p.name,
        debit: p.payment_type === 'Pay' ? p.amount : 0,
        credit: p.payment_type === 'Receive' ? p.amount : 0,
        against_voucher: p.sales_order || p.invoice || null,
        remarks: p.note || p.mode_of_payment,
      });
    }
    ledgerRaw.sort((a, b) => a.posting_date.localeCompare(b.posting_date));
    let run = 0;
    for (const row of ledgerRaw) {
      run = round2(run + row.debit - row.credit);
      row.balance = run;
    }

    const documents: any[] = [];
    for (const o of custOrders) {
      const invs = ensureOrderInvoices(o);
      for (const inv of invs) {
        documents.push({
          doctype: 'Sales Invoice',
          name: inv.name,
          date: inv.posting_date,
          amount: inv.grand_total,
          is_return: inv.is_return ? 1 : 0,
          docstatus: 1,
        });
      }
      if (o.delivery_note) {
        documents.push({ doctype: 'Delivery Note', name: o.delivery_note, date: o.delivered_date || o.transaction_date, amount: o.grand_total, docstatus: 1 });
      }
    }
    for (const p of custPayments) {
      documents.push({ doctype: 'Payment Entry', name: p.name, date: p.posting_date, amount: p.amount, docstatus: 1 });
    }
    documents.sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const orderNames = new Set(custOrders.map((o) => o.name));
    const cardFiles = s.files
      .filter(
        (f) =>
          (f.attached_to_doctype === 'Customer' && f.attached_to_name === c.name) ||
          (f.attached_to_doctype === 'Sales Order' && orderNames.has(f.attached_to_name))
      )
      .map((f) => ({
        ...f,
        atelier_subject: s.orders.find((o) => o.name === f.attached_to_name)?.title || '',
      }));

    const log = s.comments
      .filter((x) => x.reference_doctype === 'Customer' && x.reference_name === c.name)
      .map((x) => ({ ...x, by: getFullName(x.owner) }));

    // Monthly totals
    const monthMap: Record<string, number> = {};
    for (const o of custOrders) {
      const ym = o.transaction_date.slice(0, 7);
      monthMap[ym] = round2((monthMap[ym] || 0) + o.grand_total);
    }
    const months = Object.entries(monthMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([m, total]) => ({ m, total }));

    const topMap: Record<string, number> = {};
    for (const o of custOrders) {
      const k = o.title || o.lines[0]?.item_name || o.name;
      topMap[k] = (topMap[k] || 0) + 1;
    }
    const top = Object.entries(topMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([what, n]) => ({ what, n }));

    const openCustomerInvs = custOrders
      .flatMap((o) =>
        ensureOrderInvoices(o)
          .filter((i) => !i.is_return && i.outstanding_amount > 0.01)
          .map((i) => ({ inv: i, subject: o.title }))
      )
      .sort((a, b) => a.inv.due_date.localeCompare(b.inv.due_date) || a.inv.posting_date.localeCompare(b.inv.posting_date));

    const oldestEntry = openCustomerInvs[0] || null;
    const oldestUnpaid = oldestEntry
      ? {
          name: oldestEntry.inv.name,
          posting_date: oldestEntry.inv.posting_date,
          outstanding_amount: oldestEntry.inv.outstanding_amount,
          subject: oldestEntry.subject,
        }
      : null;

    const overdueDays = oldestEntry
      ? Math.max(0, daysBetween(oldestEntry.inv.due_date, todayISO()))
      : 0;

    return {
      name: c.name,
      customer_name: c.customer_name,
      mobile_no: c.mobile_no,
      email_id: c.email_id,
      customer_type: c.customer_type,
      tax_id: c.tax_id,
      notes: c.notes,
      note: c.note,
      vip: c.vip,
      relation: c.relation,
      contact_person: c.contact_person,
      since: c.creation.slice(0, 10),
      last_payment: lastPayment,
      overdue_days: overdueDays,
      can_edit: true,
      address: c.address,
      city: c.city,
      orders,
      statuses: s.board.statuses,
      balance: bal.balance,
      outstanding: bal.outstanding,
      invoiced: bal.invoiced,
      received: bal.received,
      year_paid: yearPaid,
      ledger: ledgerRaw.reverse(),
      documents,
      files: cardFiles,
      card_files: cardFiles,
      avg_pay_days: custPayments.length ? 8 : null,
      oldest_unpaid: oldestUnpaid,
      workshop: s.profile.name_ar,
      legal: { nif: c.tax_id, rc: c.rc, nis: c.nis, ai: c.ai },
      credit_limit: c.credit_limit,
      tags: c.tags || [],
      contacts: c.contacts || [],
      disabled: c.disabled,
      tva_exempt: c.tva_exempt,
      folder: s.folders.enabled ? `${s.folders.root}\\${c.customer_name}` : null,
      log,
      months,
      top,
      customer_tags: s.customer_tags,
    };
  },

  save_customer(args, user) {
    return partyHandlers.save_customer2(args, user);
  },

  save_customer2(args, user) {
    if (isWorkerRole(user.role)) throw new AtelierError('ليست لديك صلاحية', 403);
    const s = getStore();
    const d = parseJsonArg<any>(args.data ?? args, {});
    const nameStr = String(d.customer_name || '').trim();
    if (!nameStr) throw new AtelierError('اكتب اسم العميل', 417, { customer_name: 'اكتب اسم العميل' });

    let c: CustomerRecord | undefined = d.name ? s.customers.find((x) => x.name === d.name) : undefined;
    if (!c) {
      c = {
        name: `CUS-${String(s.customers.length + 1).padStart(3, '0')}`,
        customer_name: nameStr,
        customer_type: d.customer_type === 'Company' ? 'Company' : 'Individual',
        relation: d.relation || (d.customer_type === 'Company' ? 'company' : 'final'),
        contact_person: String(d.contact_person || ''),
        mobile_no: String(d.mobile_no || ''),
        email_id: String(d.email_id || ''),
        address: String(d.address || ''),
        city: String(d.city || ''),
        notes: String(d.notes || ''),
        note: String(d.note || ''),
        vip: num(d.vip, 0),
        disabled: 0,
        tax_id: String(d.tax_id || d.nif || ''),
        rc: String(d.rc || ''),
        nis: String(d.nis || ''),
        ai: String(d.ai || ''),
        credit_limit: num(d.credit_limit, 0),
        tva_exempt: num(d.tva_exempt, 0),
        tags: Array.isArray(d.tags) ? d.tags : [],
        contacts: Array.isArray(d.contacts) ? d.contacts : [],
        opening_balance: 0,
        creation: todayISO(),
      };
      s.customers.push(c);
    } else {
      c.customer_name = nameStr;
      if (d.customer_type) c.customer_type = d.customer_type === 'Company' ? 'Company' : 'Individual';
      if (d.relation !== undefined) c.relation = d.relation;
      if (d.contact_person !== undefined) c.contact_person = String(d.contact_person || '');
      if (d.mobile_no !== undefined) c.mobile_no = String(d.mobile_no || '');
      if (d.email_id !== undefined) c.email_id = String(d.email_id || '');
      if (d.address !== undefined) c.address = String(d.address || '');
      if (d.city !== undefined) c.city = String(d.city || '');
      if (d.notes !== undefined) c.notes = String(d.notes || '');
      if (d.note !== undefined) c.note = String(d.note || '');
      if (d.tax_id !== undefined || d.nif !== undefined) c.tax_id = String(d.tax_id ?? d.nif ?? '');
      if (d.rc !== undefined) c.rc = String(d.rc || '');
      if (d.nis !== undefined) c.nis = String(d.nis || '');
      if (d.ai !== undefined) c.ai = String(d.ai || '');
      if (d.credit_limit !== undefined) c.credit_limit = num(d.credit_limit, 0);
      if (d.tva_exempt !== undefined) c.tva_exempt = num(d.tva_exempt, 0);
      if (Array.isArray(d.tags)) c.tags = d.tags;
      if (Array.isArray(d.contacts)) c.contacts = d.contacts;
      for (const o of s.orders) {
        if (o.customer === c.name) o.customer_name = c.customer_name;
      }
    }
    saveStore();
    return { name: c.name, customer_name: c.customer_name, customer_type: c.customer_type };
  },

  set_customer_extra(args) {
    const s = getStore();
    const c = s.customers.find((x) => x.name === args.name);
    if (!c) throw new AtelierError('العميل غير موجود', 404);
    if (args.note !== undefined && args.note !== null) c.note = String(args.note);
    if (args.vip !== undefined && args.vip !== null) c.vip = num(args.vip) ? 1 : 0;
    saveStore();
    return { ok: true };
  },

  save_customer_tags(args) {
    const s = getStore();
    s.customer_tags = parseJsonArg<string[]>(args.tags, []).map((t) => String(t).trim()).filter(Boolean);
    saveStore();
    return s.customer_tags;
  },

  customer_credit(args) {
    const s = getStore();
    const c = s.customers.find((x) => x.name === args.name);
    if (!c) return { balance: 0, limit: 0, over: false };
    const bal = computeCustomerBalance(c.name).balance;
    return {
      balance: bal,
      limit: c.credit_limit || 0,
      over: Boolean(c.credit_limit && bal > c.credit_limit),
    };
  },

  add_customer_log(args, user) {
    const s = getStore();
    const text = String(args.text || '').trim();
    if (!text) throw new AtelierError('اكتب الملاحظة');
    const kind = args.kind ? `[${args.kind}] ` : '';
    const cmt = {
      name: nextId('CMT'),
      reference_doctype: 'Customer',
      reference_name: args.name,
      comment_type: 'Comment' as const,
      content: `${kind}${text}`,
      owner: user.email,
      creation: nowDateTime(),
    };
    s.comments.unshift(cmt);
    saveStore();
    return { ...cmt, by: user.full_name };
  },

  set_customer_disabled(args) {
    const s = getStore();
    const c = s.customers.find((x) => x.name === args.name);
    if (!c) throw new AtelierError('العميل غير موجود', 404);
    c.disabled = num(args.disabled, 1) ? 1 : 0;
    saveStore();
    return { disabled: c.disabled };
  },

  merge_customers(args) {
    const s = getStore();
    const src = s.customers.find((x) => x.name === args.source);
    const dst = s.customers.find((x) => x.name === args.target);
    if (!src || !dst || src.name === dst.name) throw new AtelierError('اختر عميلين مختلفين');
    for (const o of s.orders) {
      if (o.customer === src.name) {
        o.customer = dst.name;
        o.customer_name = dst.customer_name;
      }
    }
    for (const p of s.payments) {
      if (p.party_type === 'Customer' && p.party === src.name) {
        p.party = dst.name;
        p.party_name = dst.customer_name;
      }
    }
    s.customers = s.customers.filter((x) => x.name !== src.name);
    saveStore();
    return { ok: true };
  },

  set_file_kind(args) {
    const s = getStore();
    const f = s.files.find((x) => x.name === args.name);
    if (f) {
      f.atelier_kind = String(args.kind || '');
      saveStore();
    }
    return { ok: true };
  },

  delete_customer_file(args) {
    const s = getStore();
    s.files = s.files.filter((x) => x.name !== args.file);
    saveStore();
    return { ok: true };
  },

  // ------------------------------------------------------------------ Suppliers
  supplier_names() {
    const s = getStore();
    return s.suppliers.filter((x) => !x.disabled).map((x) => ({ name: x.name, supplier_name: x.supplier_name }));
  },

  suppliers2() {
    const s = getStore();
    const month = firstOfMonthISO();
    const today = todayISO();
    const in7 = addDays(today, 7);

    const rows = s.suppliers.map((sup) => {
      const invs = s.supplier_invoices.filter((i) => i.supplier === sup.name && i.docstatus === 1);
      const open = invs.filter((i) => i.outstanding_amount > 0.005);
      const sb = computeSupplierBalance(sup.name);
      const owe = sb.owe;
      const lateList = open.filter((i) => i.due_date && i.due_date < today);
      const late = lateList.reduce((m, i) => Math.max(m, daysBetween(i.due_date, today)), 0);
      const lateAmount = round2(lateList.reduce((a, i) => a + i.outstanding_amount, 0));
      const weekAmount = round2(
        open.filter((i) => i.due_date >= today && i.due_date <= in7).reduce((a, i) => a + i.outstanding_amount, 0)
      );
      const pos = s.purchase_orders.filter((p) => p.supplier === sup.name);
      const dates = [...invs.map((i) => i.posting_date), ...pos.map((p) => p.transaction_date)].filter(Boolean);
      const last = dates.length ? dates.sort().reverse()[0] : null;
      const monthTotal = round2(
        invs.filter((i) => i.posting_date >= month).reduce((a, i) => a + i.grand_total, 0)
      );
      return {
        name: sup.name,
        supplier_name: sup.supplier_name,
        disabled: sup.disabled,
        atelier_supplies: sup.supplies,
        atelier_phone: sup.phone,
        creation: sup.creation,
        owe,
        open_invoices: open.length,
        late,
        late_amount: lateAmount,
        week: weekAmount,
        last,
        month: monthTotal,
      };
    });

    const prevMonthStart = addDays(month, -30);
    const prevMonth = round2(
      s.supplier_invoices
        .filter((i) => i.posting_date >= prevMonthStart && i.posting_date < month)
        .reduce((a, i) => a + i.grand_total, 0)
    );

    return { rows, prev_month: prevMonth };
  },

  supplier2(args) {
    const s = getStore();
    const sup = s.suppliers.find((x) => x.name === args.name);
    if (!sup) throw new AtelierError('المورد غير موجود', 404);
    const today = todayISO();
    const year = `${new Date().getFullYear()}-01-01`;

    const invoices = s.supplier_invoices
      .filter((i) => i.supplier === sup.name && i.docstatus === 1)
      .sort((a, b) => b.posting_date.localeCompare(a.posting_date))
      .map((i) => ({
        ...i,
        late: i.due_date && i.outstanding_amount > 0.005 ? Math.max(0, daysBetween(i.due_date, today)) : 0,
        order_title: i.order_name ? s.orders.find((o) => o.name === i.order_name)?.title || null : null,
      }));

    const orders = s.purchase_orders
      .filter((p) => p.supplier === sup.name)
      .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date))
      .map((p) => ({
        ...p,
        order_title: p.order_name ? s.orders.find((o) => o.name === p.order_name)?.title || null : null,
      }));

    const itemMap: Record<string, { item_name: string; what: string; qty: number; amount: number; last: string }> = {};
    for (const inv of invoices) {
      for (const it of inv.items || []) {
        const key = it.description || it.item_name;
        const row = (itemMap[key] ||= { item_name: it.item_name, what: key, qty: 0, amount: 0, last: inv.posting_date });
        row.qty = round2(row.qty + it.qty);
        row.amount = round2(row.amount + it.amount);
        if (inv.posting_date > row.last) row.last = inv.posting_date;
      }
    }

    const payments = s.payments
      .filter((p) => p.party_type === 'Supplier' && p.party === sup.name)
      .sort((a, b) => b.posting_date.localeCompare(a.posting_date))
      .map((p) => ({
        name: p.name,
        posting_date: p.posting_date,
        paid_amount: p.amount,
        mode_of_payment: p.mode_of_payment,
        reference_no: p.reference_no || '',
      }));

    return {
      name: sup.name,
      supplier_name: sup.supplier_name,
      supplies: sup.supplies,
      phone: sup.phone,
      email: sup.email,
      address: sup.address,
      tax_id: sup.tax_id,
      rc: sup.rc,
      note: sup.note,
      disabled: sup.disabled,
      since: sup.creation.slice(0, 10),
      owe: computeSupplierBalance(sup.name).owe,
      opening_owe: computeSupplierBalance(sup.name).opening_owe,
      invoices,
      orders,
      items: Object.values(itemMap).sort((a, b) => b.amount - a.amount),
      payments,
      year_paid: round2(payments.filter((p) => p.posting_date >= year).reduce((a, p) => a + p.paid_amount, 0)),
      year_bought: round2(invoices.filter((i) => i.posting_date >= year).reduce((a, i) => a + i.grand_total, 0)),
      can_edit: true,
      accounts: s.expense_accounts,
      open_orders: s.orders
        .filter((o) => o.docstatus < 2 && !o.archived)
        .map((o) => ({ name: o.name, atelier_subject: o.title, customer_name: o.customer_name })),
    };
  },

  save_supplier(args) {
    const s = getStore();
    const d = parseJsonArg<any>(args.data ?? args, {});
    const nameStr = String(d.supplier_name || '').trim();
    if (!nameStr) throw new AtelierError('اكتب اسم المورد');
    let sup: SupplierRecord | undefined = d.name ? s.suppliers.find((x) => x.name === d.name) : undefined;
    if (!sup) {
      sup = {
        name: `SUP-${String(s.suppliers.length + 1).padStart(3, '0')}`,
        supplier_name: nameStr,
        supplies: String(d.supplies || ''),
        phone: String(d.phone || ''),
        email: String(d.email || ''),
        address: String(d.address || ''),
        tax_id: String(d.tax_id || ''),
        rc: String(d.rc || ''),
        note: String(d.note || ''),
        disabled: 0,
        opening_balance: 0,
        creation: todayISO(),
      };
      s.suppliers.push(sup);
    } else {
      sup.supplier_name = nameStr;
      if (d.supplies !== undefined) sup.supplies = String(d.supplies || '');
      if (d.phone !== undefined) sup.phone = String(d.phone || '');
      if (d.email !== undefined) sup.email = String(d.email || '');
      if (d.address !== undefined) sup.address = String(d.address || '');
      if (d.tax_id !== undefined) sup.tax_id = String(d.tax_id || '');
      if (d.rc !== undefined) sup.rc = String(d.rc || '');
      if (d.note !== undefined) sup.note = String(d.note || '');
    }
    saveStore();
    return { name: sup.name, supplier_name: sup.supplier_name };
  },

  set_supplier_disabled(args) {
    const s = getStore();
    const sup = s.suppliers.find((x) => x.name === args.name);
    if (!sup) throw new AtelierError('المورد غير موجود', 404);
    sup.disabled = num(args.disabled, 1) ? 1 : 0;
    saveStore();
    return { disabled: sup.disabled };
  },

  create_purchase_order(args) {
    const s = getStore();
    const sup = s.suppliers.find((x) => x.name === args.supplier);
    if (!sup) throw new AtelierError('المورد غير موجود', 404);
    const amount = num(args.amount, 0);
    if (amount <= 0) throw new AtelierError('المبلغ يجب أن يكون أكبر من صفر');
    const po = {
      name: nextId('PO'),
      supplier: sup.name,
      supplier_name: sup.supplier_name,
      transaction_date: todayISO(),
      schedule_date: args.schedule_date || addDays(todayISO(), 5),
      grand_total: round2(amount),
      per_billed: 0,
      per_received: 0,
      status: 'To Receive and Bill',
      order_name: args.order || null,
      what: String(args.description || 'طلب شراء').trim(),
    };
    s.purchase_orders.unshift(po);
    saveStore();
    return po;
  },

  create_supplier_invoice(args) {
    const s = getStore();
    const sup = s.suppliers.find((x) => x.name === args.supplier);
    if (!sup) throw new AtelierError('المورد غير موجود', 404);
    const amount = round2(num(args.amount, 0));
    if (amount <= 0) throw new AtelierError('المبلغ يجب أن يكون أكبر من صفر');
    const tvaRate = Math.max(0, Math.min(30, num(args.tva_rate, 0)));
    const tvaAmount = round2((amount * tvaRate) / 100);
    const grand = round2(amount + tvaAmount);
    const inv = {
      name: nextId('PI'),
      supplier: sup.name,
      supplier_name: sup.supplier_name,
      posting_date: todayISO(),
      due_date: args.due_date || addDays(todayISO(), 15),
      net_total: amount,
      tva_rate: tvaRate,
      tva_amount: tvaAmount,
      grand_total: grand,
      outstanding_amount: grand,
      bill_no: String(args.bill_no || ''),
      order_name: args.order || null,
      what: String(args.description || 'فاتورة مورد').trim(),
      account: args.account || 'EXP-SUB',
      items: [{ item_name: String(args.description || 'خدمة'), description: String(args.description || 'خدمة'), qty: 1, rate: amount, amount, is_stock: 0 }],
      docstatus: 1,
    };
    s.supplier_invoices.unshift(inv);
    if (args.purchase_order) {
      const po = s.purchase_orders.find((p) => p.name === args.purchase_order);
      if (po) {
        po.per_billed = 100;
        po.status = 'Completed';
      }
    }
    saveStore();
    return inv;
  },

  pay_supplier(args, user) {
    const s = getStore();
    const inv = s.supplier_invoices.find((i) => i.name === args.invoice);
    if (!inv) throw new AtelierError('الفاتورة غير موجودة', 404);
    const amount = round2(args.amount != null && args.amount !== '' ? num(args.amount) : inv.outstanding_amount);
    if (amount <= 0) throw new AtelierError('المبلغ يجب أن يكون أكبر من صفر');
    const paid = Math.min(amount, inv.outstanding_amount);
    const mode = args.mode_of_payment || 'Cash';
    const modeObj = s.modes.find((m) => m.value === mode) || s.modes[0];
    const payAcc = modeObj?.account || 'CASH-MAIN';
    ensureFunds(payAcc, paid);

    const pe = {
      name: nextId('PE'),
      posting_date: todayISO(),
      creation: nowDateTime(),
      payment_type: 'Pay' as const,
      party_type: 'Supplier' as const,
      party: inv.supplier,
      party_name: inv.supplier_name,
      amount: paid,
      mode_of_payment: mode,
      account: payAcc,
      invoice: inv.name,
      clearance_date: mode === 'Cheque' ? null : todayISO(),
      owner: user.email,
      note: `دفع فاتورة المورد ${inv.name}`,
    };
    s.payments.unshift(pe);
    inv.outstanding_amount = round2(Math.max(0, inv.outstanding_amount - paid));
    saveStore();
    return { name: pe.name, outstanding: inv.outstanding_amount };
  },

  purchase_bill(args, user) {
    const s = getStore();
    let sup = s.suppliers.find((x) => x.name === args.supplier || x.supplier_name === args.supplier);
    if (!sup && args.supplier) {
      sup = {
        name: `SUP-${String(s.suppliers.length + 1).padStart(3, '0')}`,
        supplier_name: String(args.supplier).trim(),
        supplies: 'مواد طباعة',
        phone: '',
        email: '',
        address: '',
        tax_id: '',
        rc: '',
        note: '',
        disabled: 0,
        opening_balance: 0,
        creation: todayISO(),
      };
      s.suppliers.push(sup);
    }
    if (!sup) throw new AtelierError('اختر المورد');
    const lines = parseJsonArg<any[]>(args.lines, []);
    if (!lines.length) throw new AtelierError('أضف سطرًا واحدًا على الأقل');

    const date = args.posting_date || todayISO();
    const tvaRate = Math.max(0, Math.min(30, num(args.tva_rate, 0)));

    // Pre-calculate totals & validate fund availability atomically BEFORE mutating stock or saving invoice
    let netTotal = 0;
    const prepared: any[] = [];
    for (const l of lines) {
      const mat = s.materials.find((m) => m.item_code === l.item_code);
      const rawQty = num(l.qty, 0);
      const rawRate = num(l.rate, 0);
      if (rawQty <= 0) continue;
      const packQty = mat && mat.cfg.pack_qty > 0 ? mat.cfg.pack_qty : 1;
      const isPack = Boolean(mat && l.uom && l.uom !== mat.uom && packQty > 1);
      const conv = isPack ? packQty : 1;
      const stockQty = round2(rawQty * conv);
      const amt = round2(rawQty * rawRate);
      netTotal = round2(netTotal + amt);
      prepared.push({ mat, rawQty, rawRate, isPack, conv, stockQty, amt, uom: isPack ? String(l.uom) : mat?.uom || '', item_name: mat?.item_name || l.item_name || 'مادة', description: mat?.item_name || l.description || 'مادة' });
    }
    if (!prepared.length) throw new AtelierError('أضف مادة واحدة على الأقل بكمية صحيحة');

    const tvaAmount = round2((netTotal * tvaRate) / 100);
    const grandTotal = round2(netTotal + tvaAmount);
    const paidAmt = round2(Math.min(grandTotal, Math.max(0, num(args.paid, 0))));
    const mode = args.mode || 'Cash';
    const modeObj = s.modes.find((m) => m.value === mode) || s.modes[0];
    const payAcc = modeObj?.account || 'CASH-MAIN';
    if (paidAmt > 0) {
      ensureFunds(payAcc, paidAmt);
    }

    const invName = nextId('PI');
    const invItems: any[] = [];
    for (const p of prepared) {
      invItems.push({
        item_code: p.mat?.item_code,
        item_name: p.item_name,
        description: p.description,
        qty: p.rawQty,
        rate: p.rawRate,
        amount: p.amt,
        uom: p.uom,
        conversion_factor: p.conv,
        is_stock: p.mat ? 1 : 0,
      });
      if (p.mat) {
        const oldVal = p.mat.qty * p.mat.valuation_rate;
        p.mat.qty = round2(p.mat.qty + p.stockQty);
        if (p.mat.qty > 0 && p.amt > 0) {
          p.mat.valuation_rate = round2((oldVal + p.amt) / p.mat.qty);
        }
        if (p.isPack) {
          p.mat.cfg.closed = Math.max(0, (p.mat.cfg.closed || 0) + Math.floor(p.rawQty));
        } else if (p.mat.cfg.pack_qty > 0 && p.stockQty >= p.mat.cfg.pack_qty) {
          p.mat.cfg.closed = Math.max(0, (p.mat.cfg.closed || 0) + Math.floor(p.stockQty / p.mat.cfg.pack_qty));
        }
        s.stock_moves.unshift({
          id: `SM-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          posting_date: date,
          creation: nowDateTime(),
          item_code: p.mat.item_code,
          item_name: p.mat.item_name,
          warehouse: 'مخزن المطبعة',
          actual_qty: p.stockQty,
          voucher_type: 'Purchase Invoice',
          voucher_no: invName,
          stock_value_difference: p.amt,
          uom: p.uom,
          conversion_factor: p.conv,
          buy_rate: p.rawRate,
          supplier_name: sup.supplier_name,
          owner: user.email,
        });
      }
    }

    const inv = {
      name: invName,
      supplier: sup.name,
      supplier_name: sup.supplier_name,
      posting_date: date,
      due_date: args.due_date || addDays(date, 15),
      net_total: netTotal,
      tva_rate: tvaRate,
      tva_amount: tvaAmount,
      grand_total: grandTotal,
      outstanding_amount: round2(grandTotal - paidAmt),
      bill_no: String(args.bill_no || ''),
      order_name: null,
      what: invItems.map((i) => i.item_name).join(' + ').slice(0, 120),
      account: 'EXP-OFFICE',
      items: invItems,
      docstatus: 1,
    };
    s.supplier_invoices.unshift(inv);

    if (paidAmt > 0) {
      s.payments.unshift({
        name: nextId('PE'),
        posting_date: date,
        creation: nowDateTime(),
        payment_type: 'Pay',
        party_type: 'Supplier',
        party: sup.name,
        party_name: sup.supplier_name,
        amount: paidAmt,
        mode_of_payment: mode,
        account: payAcc,
        invoice: invName,
        clearance_date: mode === 'Cheque' ? null : date,
        owner: user.email,
        note: `دفع عند تسجيل فاتورة الشراء ${invName}`,
      });
    }
    saveStore();
    return { name: invName, net_total: netTotal, tva_amount: tvaAmount, grand_total: grandTotal, owed: inv.outstanding_amount, outstanding: inv.outstanding_amount };
  },

  // ------------------------------------------------------------------ Party Opening Balances
  opening_info(args) {
    const s = getStore();
    const pt = args.party_type as 'Customer' | 'Supplier';
    const entries = s.openings.filter((o) => !o.reversed && o.kind === pt && o.target === args.party);
    return {
      entries,
      total: round2(entries.reduce((a, b) => a + b.amount, 0)),
    };
  },

  add_opening(args) {
    const s = getStore();
    const pt = args.party_type as 'Customer' | 'Supplier';
    const amount = num(args.amount, 0);
    if (!amount) throw new AtelierError('أدخل مبلغًا غير صفري');
    const label =
      pt === 'Customer'
        ? s.customers.find((c) => c.name === args.party)?.customer_name || args.party
        : s.suppliers.find((x) => x.name === args.party)?.supplier_name || args.party;
    const entry = {
      name: nextId('JE'),
      kind: pt,
      target: args.party,
      target_label: label,
      amount: round2(amount),
      posting_date: args.date || todayISO(),
      remark: String(args.remark || 'رصيد افتتاحي'),
    };
    s.openings.unshift(entry);
    saveStore();
    return entry;
  },

  reverse_opening(args) {
    const s = getStore();
    const op = s.openings.find((o) => o.name === args.journal);
    if (op) op.reversed = 1;
    saveStore();
    return { ok: true };
  },
};
