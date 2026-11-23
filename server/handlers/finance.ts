import {
  AtelierError,
  addCardLog,
  addDays,
  computeFundBalance,
  computeOrderBillingBreakdown,
  computeSupplierBalance,
  daysBetween,
  ensureFunds,
  ensureOrderInvoices,
  getFullName,
  getPeriodBounds,
  getStore,
  nextId,
  nowDateTime,
  num,
  round2,
  saveStore,
  syncOrderTotals,
  todayISO,
} from '../store.ts';
import { UserAccount } from '../types.ts';

function monthBounds(offset = 0): [string, string, string, string] {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + offset;
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  const pStart = new Date(Date.UTC(y, m - 1, 1));
  const pEnd = new Date(Date.UTC(y, m, 0));
  return [
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10),
    pStart.toISOString().slice(0, 10),
    pEnd.toISOString().slice(0, 10),
  ];
}

export const financeHandlers: Record<string, (args: Record<string, any>, user: UserAccount) => any> = {
  money(_args, user) {
    return financeHandlers.money3({ offset: 0 }, user);
  },

  money3(args) {
    const s = getStore();
    const offset = Math.trunc(num(args.offset, 0));
    const [start, end, pStart, pEnd] = monthBounds(offset);
    const today = todayISO();

    const fundLabel = (acc: string) => s.funds.find((f) => f.name === acc)?.account_name || acc;

    const cheques = s.payments
      .filter((p) => !p.bounced && p.payment_type === 'Receive' && p.mode_of_payment === 'Cheque' && !p.clearance_date)
      .map((p) => ({
        name: p.name,
        party_name: p.party_name,
        amount: p.amount,
        reference_no: p.reference_no || '',
        reference_date: p.reference_date || p.posting_date,
        posting_date: p.posting_date,
        paid_to: p.account,
      }));

    const funds = s.funds.map((f) => ({
      name: f.name,
      label: f.account_name,
      type: f.account_type,
      balance: computeFundBalance(f.name),
      last_closing: s.closings.find((c) => c.account === f.name) || null,
      cheques: cheques.filter((c) => c.paid_to === f.name).length,
    }));

    // Build moves in [start, end]
    const moves: any[] = [];
    for (const p of s.payments) {
      if (p.bounced || p.posting_date < start || p.posting_date > end) continue;
      // Uncleared cheques are tracked in the pending cheques clearing section until bank clearance
      if (p.mode_of_payment === 'Cheque' && !p.clearance_date) continue;
      const isIn = p.payment_type === 'Receive';
      const ord = p.sales_order ? s.orders.find((o) => o.name === p.sales_order) : null;
      moves.push({
        posting_date: p.posting_date,
        creation: p.creation,
        voucher_type: 'Payment Entry',
        voucher_no: p.name,
        account: p.account,
        fund: fundLabel(p.account),
        amount: isIn ? p.amount : -p.amount,
        kind: isIn ? 'in' : 'out',
        title: isIn ? `تحصيل من ${p.party_name}` : `دفع إلى ${p.party_name}`,
        by: getFullName(p.owner),
        category: p.party_type === 'Customer' ? 'تحصيل عميل' : 'دفعة مورد',
        order: p.sales_order || null,
        order_title: ord?.title || null,
        ref: p.reference_no || null,
        files: 0,
      });
    }

    for (const e of s.expenses) {
      if (e.posting_date < start || e.posting_date > end) continue;
      const ord = e.sales_order ? s.orders.find((o) => o.name === e.sales_order) : null;
      moves.push({
        posting_date: e.posting_date,
        creation: e.creation,
        voucher_type: 'Journal Entry',
        voucher_no: e.name,
        account: e.paid_from,
        fund: fundLabel(e.paid_from),
        amount: -e.amount,
        kind: 'out',
        title: e.description,
        by: getFullName(e.owner),
        category: e.account_name,
        order: e.sales_order || null,
        order_title: ord?.title || null,
        ref: null,
        files: 0,
      });
    }

    for (const t of s.transfers) {
      if (t.posting_date < start || t.posting_date > end) continue;
      moves.push({
        posting_date: t.posting_date,
        creation: t.creation,
        voucher_type: 'Journal Entry',
        voucher_no: t.name,
        account: t.to_account,
        fund: `${fundLabel(t.from_account)} ← ${fundLabel(t.to_account)}`,
        amount: t.amount,
        moved: t.amount,
        kind: 'transfer',
        title: t.note || 'تحويل بين الصناديق',
        by: getFullName(t.owner),
        category: 'تحويل بين الصناديق',
        order: null,
        order_title: null,
        ref: null,
        files: 0,
      });
    }

    for (const om of s.owner_moves) {
      if (om.posting_date < start || om.posting_date > end) continue;
      moves.push({
        posting_date: om.posting_date,
        creation: om.creation,
        voucher_type: 'Journal Entry',
        voucher_no: om.name,
        account: om.account,
        fund: fundLabel(om.account),
        amount: om.kind === 'in' ? om.amount : -om.amount,
        kind: 'owner',
        title: om.note || (om.kind === 'in' ? 'إيداع من المالك' : 'سحب شخصي'),
        by: getFullName(om.owner),
        category: om.kind === 'in' ? 'إيداع من المالك' : 'سحب شخصي',
        order: null,
        order_title: null,
        ref: null,
        files: 0,
      });
    }

    moves.sort((a, b) => (b.posting_date + b.creation).localeCompare(a.posting_date + a.creation));

    const sumRange = (a: string, b: string) => {
      const inc = round2(
        s.payments
          .filter(
            (p) =>
              !p.bounced &&
              !(p.mode_of_payment === 'Cheque' && !p.clearance_date) &&
              p.party_type === 'Customer' &&
              p.payment_type === 'Receive' &&
              p.posting_date >= a &&
              p.posting_date <= b
          )
          .reduce((acc, p) => acc + p.amount, 0)
      );
      const exp = round2(
        s.expenses
          .filter((e) => e.posting_date >= a && e.posting_date <= b)
          .reduce((acc, e) => acc + e.amount, 0) +
          s.payments
            .filter((p) => !p.bounced && p.party_type === 'Supplier' && p.payment_type === 'Pay' && p.posting_date >= a && p.posting_date <= b)
            .reduce((acc, p) => acc + p.amount, 0)
      );
      return [inc, exp];
    };

    const [income, expenses] = sumRange(start, end);
    const [pin, pout] = sumRange(pStart, pEnd);

    const ownerOut = round2(
      s.owner_moves
        .filter((x) => x.kind === 'out' && x.posting_date >= start && x.posting_date <= end)
        .reduce((a, b) => a + b.amount, 0)
    );
    const ownerIn = round2(
      s.owner_moves
        .filter((x) => x.kind === 'in' && x.posting_date >= start && x.posting_date <= end)
        .reduce((a, b) => a + b.amount, 0)
    );

    const payers = new Set(
      s.payments
        .filter((p) => p.party_type === 'Customer' && p.payment_type === 'Receive' && p.posting_date >= start && p.posting_date <= end)
        .map((p) => p.party)
    ).size;

    // Expense categories
    const catMap: Record<string, number> = {};
    for (const e of s.expenses) {
      if (e.posting_date >= start && e.posting_date <= end) {
        catMap[e.account_name] = round2((catMap[e.account_name] || 0) + e.amount);
      }
    }
    for (const p of s.payments) {
      if (p.party_type === 'Supplier' && p.payment_type === 'Pay' && p.posting_date >= start && p.posting_date <= end) {
        catMap['مشتريات مواد وموردين'] = round2((catMap['مشتريات مواد وموردين'] || 0) + p.amount);
      }
    }
    const categories = Object.entries(catMap)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8);

    // 4 weeks inside the month
    const weeks = [0, 1, 2, 3].map((w) => {
      const ws = addDays(start, w * 7);
      const we = w === 3 ? end : addDays(start, w * 7 + 6);
      const [wi, wo] = sumRange(ws, we);
      return { label: `الأسبوع ${w + 1}`, in: wi, out: wo };
    });

    // Debtors & Ageing (accurate split between open invoices and unbilled portion — no double counting on partial billing)
    const debtorMap: Record<string, any> = {};
    const ages = { a: 0, b: 0, c: 0 };
    const ensureDebtor = (custId: string, custName: string) => {
      const cust = s.customers.find((c) => c.name === custId);
      return (debtorMap[custId] ||= {
        customer: custId,
        customer_name: custName || cust?.customer_name || custId,
        amount: 0,
        invoices: 0,
        unbilled: 0,
        late: 0,
        mobile_no: cust?.mobile_no || '',
      });
    };

    for (const o of s.orders) {
      if (o.docstatus === 2 || o.price_pending) continue;
      const br = computeOrderBillingBreakdown(o);
      if (br.billedOutstanding <= 0.005 && br.unbilledDue <= 0.005) continue;
      const d = ensureDebtor(o.customer, o.customer_name);

      if (br.billedOutstanding > 0.005) {
        const invs = ensureOrderInvoices(o).filter((i) => !i.is_return && i.outstanding_amount > 0.005);
        for (const inv of invs) {
          d.invoices = round2(d.invoices + inv.outstanding_amount);
          d.amount = round2(d.amount + inv.outstanding_amount);
          const late = Math.max(0, daysBetween(inv.due_date, today));
          if (late > d.late) d.late = late;
          if (late <= 30) ages.a = round2(ages.a + inv.outstanding_amount);
          else if (late <= 60) ages.b = round2(ages.b + inv.outstanding_amount);
          else ages.c = round2(ages.c + inv.outstanding_amount);
        }
      }
      if (br.unbilledDue > 0.005) {
        d.unbilled = round2(d.unbilled + br.unbilledDue);
        d.amount = round2(d.amount + br.unbilledDue);
      }
    }

    // Include customer opening balances so debtors match ledger balances
    for (const c of s.customers) {
      const openBal = round2(
        (c.opening_balance || 0) +
          s.openings
            .filter((op) => !op.reversed && op.kind === 'Customer' && op.target === c.name)
            .reduce((a, b) => a + b.amount, 0)
      );
      if (openBal > 0.005) {
        const d = ensureDebtor(c.name, c.customer_name);
        d.invoices = round2(d.invoices + openBal);
        d.amount = round2(d.amount + openBal);
        ages.c = round2(ages.c + openBal);
      }
    }

    const debtors = Object.values(debtorMap)
      .filter((d: any) => d.amount > 0.005)
      .sort((x: any, y: any) => y.late - x.late || y.amount - x.amount);

    const payables: any[] = s.supplier_invoices
      .filter((i) => i.docstatus === 1 && i.outstanding_amount > 0.005)
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
      .map((i) => ({
        name: i.name,
        supplier: i.supplier,
        supplier_name: i.supplier_name,
        amount: i.outstanding_amount,
        due_date: i.due_date,
        what: i.what,
      }));

    // Include supplier opening balances so payables match suppliers2 ledger
    for (const sup of s.suppliers) {
      const sb = computeSupplierBalance(sup.name);
      if (sb.opening_owe > 0.005) {
        payables.push({
          name: `OP-${sup.name}`,
          supplier: sup.name,
          supplier_name: sup.supplier_name,
          amount: sb.opening_owe,
          due_date: sup.creation || today,
          what: 'رصيد افتتاحي للمورد',
          is_opening: 1,
        });
      }
    }

    return {
      month: start,
      offset,
      funds,
      ages,
      cheques,
      pending_cheques_total: round2(cheques.reduce((a, c) => a + c.amount, 0)),
      closings: s.closings.slice(0, 10),
      cash_balance: round2(funds.reduce((a, f) => a + f.balance, 0)),
      income,
      expenses,
      profit: round2(income - expenses),
      owner_out: ownerOut,
      owner_in: ownerIn,
      prev_income: pin,
      prev_expenses: pout,
      payers,
      weeks,
      moves,
      total_moves: moves.length,
      categories,
      debtors,
      payables,
      modes: s.modes.map((m) => ({ value: m.value, label: m.label })),
    };
  },

  expense_options() {
    const s = getStore();
    const counts: Record<string, number> = {};
    for (const e of s.expenses) counts[e.account] = (counts[e.account] || 0) + 1;
    const accounts = s.expense_accounts.map((a) => ({ ...a, used: counts[a.name] || 0 }));
    const orders = s.orders
      .filter((o) => o.docstatus < 2 && !o.archived)
      .map((o) => ({
        name: o.name,
        project: o.name,
        atelier_subject: o.title,
        customer_name: o.customer_name,
      }));
    return { accounts, orders };
  },

  record_payment(args, user) {
    const s = getStore();
    const amount = round2(num(args.amount, 0));
    if (amount <= 0) throw new AtelierError('المبلغ يجب أن يكون أكبر من صفر');
    const cust = s.customers.find((c) => c.name === args.customer);
    if (!cust) throw new AtelierError('العميل غير موجود', 404);
    const mode = args.mode_of_payment || 'Cash';
    const modeObj = s.modes.find((m) => m.value === mode) || s.modes[0];
    const salesFund = user.role === 'sales' ? s.funds.find((f) => f.user === user.email) : null;
    const account = mode === 'Cash' && salesFund ? salesFund.name : modeObj?.account || 'CASH-MAIN';

    const targetOrder = args.sales_order ? s.orders.find((o) => o.name === args.sales_order) : null;
    if (targetOrder && !targetOrder.price_pending && targetOrder.docstatus === 1) {
      const left = round2(Math.max(0, targetOrder.grand_total - targetOrder.paid));
      if (amount > left + 0.005) {
        throw new AtelierError(
          `المبلغ أكبر من الباقي على هذا الطلب (${left} دج). إن كان العميل يدفع مسبقًا لطلب آخر، سجّلها من ملفه دون ربطها بطلب.`
        );
      }
    }

    const allocations: { invoice?: string | null; order?: string | null; amount: number }[] = [];
    let rem = amount;

    if (targetOrder) {
      // Distribute payment FIFO across ALL open invoices of this order (supports multiple partial invoices)
      const openInvs = ensureOrderInvoices(targetOrder)
        .filter((i) => !i.is_return && i.outstanding_amount > 0.005)
        .sort((a, b) => a.posting_date.localeCompare(b.posting_date) || a.due_date.localeCompare(b.due_date));
      for (const inv of openInvs) {
        if (rem <= 0.005) break;
        const take = round2(Math.min(rem, inv.outstanding_amount));
        inv.paid_amount = round2(inv.paid_amount + take);
        inv.outstanding_amount = round2(Math.max(0, inv.outstanding_amount - take));
        allocations.push({ order: targetOrder.name, invoice: inv.name, amount: take });
        rem = round2(rem - take);
      }
    } else {
      // General customer payment: allocate FIFO across open invoices first, then unbilled orders
      const custOrders = s.orders
        .filter((o) => o.customer === cust.name && o.docstatus < 2 && !o.price_pending)
        .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));

      const openInvoicePairs: { order: (typeof custOrders)[number]; inv: ReturnType<typeof ensureOrderInvoices>[number] }[] = [];
      for (const ord of custOrders) {
        for (const inv of ensureOrderInvoices(ord)) {
          if (!inv.is_return && inv.outstanding_amount > 0.005) {
            openInvoicePairs.push({ order: ord, inv });
          }
        }
      }
      openInvoicePairs.sort(
        (a, b) => a.inv.due_date.localeCompare(b.inv.due_date) || a.inv.posting_date.localeCompare(b.inv.posting_date)
      );
      for (const { order: ord, inv } of openInvoicePairs) {
        if (rem <= 0.005) break;
        const take = round2(Math.min(rem, inv.outstanding_amount));
        inv.paid_amount = round2(inv.paid_amount + take);
        inv.outstanding_amount = round2(Math.max(0, inv.outstanding_amount - take));
        allocations.push({ order: ord.name, invoice: inv.name, amount: take });
        rem = round2(rem - take);
      }
      for (const ord of custOrders) {
        if (rem <= 0.005) break;
        const br = computeOrderBillingBreakdown(ord);
        if (br.unbilledDue <= 0.005) continue;
        const take = round2(Math.min(rem, br.unbilledDue));
        allocations.push({ order: ord.name, invoice: null, amount: take });
        rem = round2(rem - take);
      }
    }

    const pe = {
      name: nextId('PE'),
      posting_date: args.posting_date || todayISO(),
      creation: nowDateTime(),
      payment_type: 'Receive' as const,
      party_type: 'Customer' as const,
      party: cust.name,
      party_name: cust.customer_name,
      amount,
      mode_of_payment: mode,
      account,
      // Always keep sales_order tagged even when price_pending/draft so invoice_order auto-deducts it
      sales_order: targetOrder ? targetOrder.name : null,
      invoice: args.invoice || allocations[0]?.invoice || null,
      reference_no: args.reference_no || null,
      reference_date: args.reference_date || null,
      clearance_date: mode === 'Cheque' ? null : todayISO(),
      allocations,
      unallocated_amount: round2(Math.max(0, rem)),
      owner: user.email,
      note: args.note || '',
    };
    s.payments.unshift(pe);

    if (targetOrder) {
      syncOrderTotals(targetOrder);
    } else {
      const touched = new Set(allocations.map((a) => a.order).filter(Boolean));
      for (const ordName of touched) {
        const ord = s.orders.find((o) => o.name === ordName);
        if (ord) syncOrderTotals(ord);
      }
    }
    saveStore();
    return pe.name;
  },

  record_expense(args, user) {
    const s = getStore();
    const amount = round2(num(args.amount, 0));
    if (amount <= 0) throw new AtelierError('المبلغ يجب أن يكون أكبر من صفر');
    const description = String(args.description || '').trim();
    if (!description) throw new AtelierError('اكتب بيان المصروف');
    const acc = s.expense_accounts.find((a) => a.name === args.account) || s.expense_accounts[0];
    const mode = args.mode_of_payment || 'Cash';
    const modeObj = s.modes.find((m) => m.value === mode) || s.modes[0];
    const paidFrom = modeObj?.account || 'CASH-MAIN';
    ensureFunds(paidFrom, amount);

    const exp = {
      name: nextId('JE'),
      posting_date: args.posting_date || todayISO(),
      creation: nowDateTime(),
      account: acc.name,
      account_name: acc.account_name,
      amount,
      mode_of_payment: mode,
      paid_from: paidFrom,
      description,
      sales_order: args.sales_order || null,
      owner: user.email,
    };
    s.expenses.unshift(exp);
    saveStore();
    return { name: exp.name, project: args.sales_order || null };
  },

  close_cash(args, user) {
    const s = getStore();
    const fund = s.funds.find((f) => f.name === args.account);
    if (!fund) throw new AtelierError('الصندوق غير موجود', 404);
    const recorded = computeFundBalance(fund.name);
    const counted = round2(num(args.counted, 0));
    if (counted < 0) throw new AtelierError('المبلغ المعدود لا يكون سالبًا');
    const diff = round2(counted - recorded);
    const note = String(args.note || '').trim();
    if (Math.abs(diff) > 1000 && !note) {
      throw new AtelierError('يوجد فرق كبير في الصندوق (أكثر من 1,000 دج) — اكتب سبب الفرق في الملاحظة قبل الإغلاق');
    }
    const closing = {
      id: `CL-${Date.now().toString(36)}`,
      account: fund.name,
      label: fund.account_name,
      at: nowDateTime(),
      date: todayISO(),
      recorded,
      counted,
      diff,
      note,
      by: user.full_name,
    };
    s.closings.unshift(closing);
    saveStore();
    return closing;
  },

  clear_cheque(args) {
    const s = getStore();
    const pe = s.payments.find((p) => p.name === args.name && !p.bounced);
    if (!pe) throw new AtelierError('الشيك غير موجود', 404);
    if (pe.clearance_date) throw new AtelierError('هذا الشيك محصّل بالفعل');
    pe.clearance_date = args.date || todayISO();
    saveStore();
    return { ok: true, clearance_date: pe.clearance_date };
  },

  bounce_cheque(args, user) {
    const s = getStore();
    const pe = s.payments.find((p) => p.name === args.name && !p.bounced);
    if (!pe) throw new AtelierError('الشيك غير موجود', 404);
    if (pe.clearance_date) {
      throw new AtelierError('لا يمكن تسجيل شيك محصّل كمرتجع بعد التحصيل');
    }
    const reason = String(args.reason || 'شيك مرتجع بدون رصيد').trim().slice(0, 200);
    pe.bounced = 1;
    pe.bounce_reason = reason;

    // Reverse allocations on affected invoices & resync order balances so customer debt is accurately restored
    const touchedOrders = new Set<string>();
    if (pe.sales_order) touchedOrders.add(pe.sales_order);
    if (Array.isArray(pe.allocations) && pe.allocations.length) {
      for (const al of pe.allocations) {
        if (al.order) {
          touchedOrders.add(al.order);
          const ord = s.orders.find((o) => o.name === al.order);
          if (ord && al.invoice) {
            const inv = ensureOrderInvoices(ord).find((i) => i.name === al.invoice);
            if (inv) {
              inv.paid_amount = round2(Math.max(0, inv.paid_amount - al.amount));
              inv.outstanding_amount = round2(Math.min(inv.grand_total, inv.outstanding_amount + al.amount));
            }
          }
        }
      }
    } else if (pe.sales_order) {
      const ord = s.orders.find((o) => o.name === pe.sales_order);
      if (ord) {
        let rev = pe.amount;
        for (const inv of ensureOrderInvoices(ord).filter((i) => !i.is_return && i.paid_amount > 0.005).reverse()) {
          if (rev <= 0.005) break;
          const back = round2(Math.min(rev, inv.paid_amount));
          inv.paid_amount = round2(inv.paid_amount - back);
          inv.outstanding_amount = round2(inv.outstanding_amount + back);
          rev = round2(rev - back);
        }
      }
    }

    for (const ordName of touchedOrders) {
      const ord = s.orders.find((o) => o.name === ordName);
      if (ord) {
        syncOrderTotals(ord);
        addCardLog(ord.name, `شيك مرتجع (${pe.reference_no || pe.name}) بمبلغ ${pe.amount} دج — ${reason}`, user.email, 'Info');
      }
    }
    saveStore();
    return { ok: true, amount: pe.amount, customer: pe.party };
  },

  owner_move(args, user) {
    const s = getStore();
    const amount = round2(num(args.amount, 0));
    if (amount <= 0) throw new AtelierError('المبلغ يجب أن يكون أكبر من صفر');
    const kind = args.kind === 'in' || args.kind === 'deposit' ? 'in' : 'out';
    const account = args.account || 'CASH-MAIN';
    if (kind === 'out') ensureFunds(account, amount);
    const rec = {
      name: nextId('JE'),
      posting_date: todayISO(),
      creation: nowDateTime(),
      kind: kind as 'in' | 'out',
      account,
      amount,
      note: String(args.note || (kind === 'in' ? 'إيداع من المالك' : 'سحب شخصي')),
      owner: user.email,
    };
    s.owner_moves.unshift(rec);
    saveStore();
    return rec;
  },

  transfer_funds(args, user) {
    const s = getStore();
    const amount = round2(num(args.amount, 0));
    if (amount <= 0) throw new AtelierError('المبلغ يجب أن يكون أكبر من صفر');
    if (!args.from_account || !args.to_account || args.from_account === args.to_account) {
      throw new AtelierError('اختر صندوقين مختلفين للتحويل');
    }
    ensureFunds(args.from_account, amount);
    const rec = {
      name: nextId('JE'),
      posting_date: todayISO(),
      creation: nowDateTime(),
      from_account: args.from_account,
      to_account: args.to_account,
      amount,
      note: String(args.note || 'تحويل بين الصناديق'),
      owner: user.email,
    };
    s.transfers.unshift(rec);
    saveStore();
    return rec;
  },

  // ------------------------------------------------------------------ Seller Cashbox
  my_box(_args, user) {
    const s = getStore();
    const fund = s.funds.find((f) => f.user === user.email);
    const pending = s.handovers.find((h) => h.user === user.email && h.status === 'pending') || null;
    const lastConfirmed = s.handovers.find((h) => h.user === user.email && h.status === 'confirmed');
    const since = lastConfirmed?.resolved_at || null;
    const collections = fund
      ? s.payments
          .filter((p) => p.payment_type === 'Receive' && p.account === fund.name && (!since || p.creation > since))
          .map((p) => ({
            name: p.name,
            posting_date: p.posting_date,
            party_name: p.party_name,
            paid_amount: p.amount,
            creation: p.creation,
          }))
      : [];
    return {
      account: fund?.name || null,
      name: user.full_name,
      balance: fund ? computeFundBalance(fund.name) : 0,
      since,
      pending,
      collections,
    };
  },

  hand_over(args, user) {
    const s = getStore();
    const fund = s.funds.find((f) => f.user === user.email);
    if (!fund) throw new AtelierError('لا يوجد صندوق باسمك بعد');
    if (s.handovers.some((h) => h.user === user.email && h.status === 'pending')) {
      throw new AtelierError('لديك تسليم بانتظار تأكيد المدير');
    }
    const recorded = computeFundBalance(fund.name);
    const counted = round2(num(args.counted, 0));
    if (recorded <= 0 && counted <= 0) throw new AtelierError('الصندوق فارغ');
    const row = {
      id: `HO-${Date.now().toString(36)}`,
      user: user.email,
      name: user.full_name,
      account: fund.name,
      at: nowDateTime(),
      recorded,
      counted,
      diff: round2(counted - recorded),
      reason: String(args.reason || '').trim().slice(0, 200),
      count: s.payments.filter((p) => p.account === fund.name && p.payment_type === 'Receive').length,
      status: 'pending' as const,
    };
    s.handovers.unshift(row);
    saveStore();
    return row;
  },

  boxes(_args, user) {
    if (user.role !== 'manager') throw new AtelierError('للمدير فقط', 403);
    const s = getStore();
    const pending = s.handovers.filter((h) => h.status === 'pending');
    const boxes = s.funds
      .filter((f) => f.user)
      .map((f) => ({
        account: f.name,
        label: f.account_name,
        balance: computeFundBalance(f.name),
        pending: pending.find((h) => h.account === f.name)?.id || null,
      }));
    return {
      pending,
      boxes,
      main: 'CASH-MAIN',
      recent: s.handovers.filter((h) => h.status !== 'pending').slice(0, 10),
    };
  },

  confirm_handover(args, user) {
    if (user.role !== 'manager') throw new AtelierError('للمدير فقط', 403);
    const s = getStore();
    const h = s.handovers.find((x) => x.id === args.id && x.status === 'pending');
    if (!h) throw new AtelierError('هذا التسليم لم يعد بانتظار التأكيد');
    // Recompute live box balance at confirmation time so payments collected while pending are never lost
    const liveRecorded = computeFundBalance(h.account);
    h.recorded = liveRecorded;
    h.diff = round2(h.counted - liveRecorded);
    if (Math.abs(h.diff) > 1000 && !h.reason && !args.reason) {
      throw new AtelierError(
        `يوجد فرق ${Math.abs(h.diff)} دج بين الرصيد الفعلي (${liveRecorded} دج) والمعدود (${h.counted} دج) — اطلب إعادة العدّ أو سجّل سبب الفرق.`
      );
    }
    if (args.reason) h.reason = String(args.reason).trim().slice(0, 200);
    h.status = 'confirmed';
    h.resolved_at = nowDateTime();
    saveStore();
    return h;
  },

  reject_handover(args, user) {
    if (user.role !== 'manager') throw new AtelierError('للمدير فقط', 403);
    const s = getStore();
    const h = s.handovers.find((x) => x.id === args.id && x.status === 'pending');
    if (!h) throw new AtelierError('هذا التسليم لم يعد بانتظار التأكيد');
    h.status = 'rejected';
    h.resolved_at = nowDateTime();
    saveStore();
    return h;
  },

  // ------------------------------------------------------------------ Opening Balances (Funds)
  opening_balances() {
    const s = getStore();
    return {
      funds: s.funds.map((f) => ({ name: f.name, label: f.account_name, type: f.account_type })),
      entries: s.openings
        .filter((o) => !o.reversed && o.kind === 'fund')
        .map((o) => ({
          name: o.name,
          account: o.target,
          label: o.target_label,
          amount: o.amount,
          posting_date: o.posting_date,
        })),
    };
  },

  save_opening(args) {
    const s = getStore();
    const amount = round2(num(args.amount, 0));
    if (amount <= 0) throw new AtelierError('المبلغ يجب أن يكون أكبر من صفر');
    const fund = s.funds.find((f) => f.name === args.account);
    if (!fund) throw new AtelierError('الصندوق غير موجود');
    const entry = {
      name: nextId('JE'),
      kind: 'fund' as const,
      target: fund.name,
      target_label: fund.account_name,
      amount,
      posting_date: args.posting_date || todayISO(),
      remark: `رصيد افتتاحي — ${fund.account_name}`,
    };
    s.openings.unshift(entry);
    saveStore();
    return entry;
  },

  cancel_opening(args) {
    const s = getStore();
    const op = s.openings.find((o) => o.name === args.entry);
    if (op) op.reversed = 1;
    saveStore();
    return { ok: true };
  },

  // ------------------------------------------------------------------ Reports
  reports(args, user) {
    return financeHandlers.reports2(args, user);
  },

  reports2(args) {
    const s = getStore();
    const period = args.period || 'month';
    const [a, b, pa, pb] = getPeriodBounds(period, args.start, args.end);
    const today = todayISO();

    const figures = (x: string, y: string) => {
      const ords = s.orders.filter((o) => o.docstatus < 2 && o.transaction_date >= x && o.transaction_date <= y);
      // Net invoiced revenue in [x, y] includes partial invoices and deducts credit notes (returns)
      let invoiced = 0;
      for (const o of s.orders) {
        if (o.docstatus === 2) continue;
        for (const inv of ensureOrderInvoices(o)) {
          if (inv.posting_date >= x && inv.posting_date <= y) {
            invoiced = round2(invoiced + inv.net_total);
          }
        }
      }
      const collected = round2(
        s.payments
          .filter((p) => p.party_type === 'Customer' && p.posting_date >= x && p.posting_date <= y)
          .reduce((acc, p) => acc + (p.payment_type === 'Receive' ? p.amount : -p.amount), 0)
      );
      // Real accrual expenses: direct expenses + consumed materials (COGS) + non-stock supplier bills
      const directExp = s.expenses
        .filter((e) => e.posting_date >= x && e.posting_date <= y)
        .reduce((acc, e) => acc + e.amount, 0);
      const stockCogs = s.stock_moves
        .filter((sm) => sm.voucher_type === 'Stock Entry' && sm.actual_qty < 0 && sm.posting_date >= x && sm.posting_date <= y)
        .reduce((acc, sm) => acc + Math.abs(sm.stock_value_difference), 0);
      const nonStockBills = s.supplier_invoices
        .filter((pi) => pi.docstatus === 1 && pi.posting_date >= x && pi.posting_date <= y)
        .reduce(
          (acc, pi) =>
            acc + (pi.items || []).filter((it) => !it.is_stock).reduce((a2, it) => a2 + num(it.amount), 0),
          0
        );
      const expenses = round2(directExp + stockCogs + nonStockBills);
      const income = Math.max(0, invoiced);
      return {
        invoiced: Math.max(0, invoiced),
        collected,
        income,
        expenses,
        profit: round2(income - expenses),
        orders: ords.length,
        orders_total: round2(ords.reduce((acc, o) => acc + o.grand_total, 0)),
      };
    };

    const now = figures(a, b) as any;
    const prev = figures(pa, pb);

    const deliveredInPeriod = s.orders.filter(
      (o) => o.per_delivered >= 100 && o.delivered_date && o.delivered_date >= a && o.delivered_date <= b
    );
    now.delivered = deliveredInPeriod.length;
    now.late = deliveredInPeriod.filter((o) => o.delivery_date && o.delivered_date! > o.delivery_date).length;

    // Last 12 months
    const months: { month: string; sales: number; expenses: number }[] = [];
    const baseDate = new Date(b + 'T00:00:00Z');
    for (let i = 11; i >= 0; i--) {
      const mStart = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() - i, 1));
      const mEnd = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() - i + 1, 0));
      const ms = mStart.toISOString().slice(0, 10);
      const me = mEnd.toISOString().slice(0, 10);
      const f = figures(ms, me);
      const fallbackOrders = round2(
        s.orders
          .filter((o) => o.docstatus < 2 && o.transaction_date >= ms && o.transaction_date <= me)
          .reduce((acc, o) => acc + o.net_total, 0)
      );
      months.push({ month: ms, sales: f.invoiced || fallbackOrders, expenses: f.expenses });
    }

    // Profit per order (uses net_total already adjusted for returns)
    const profit = s.orders
      .filter((o) => o.docstatus < 2 && !o.price_pending && o.net_total > 0 && o.transaction_date >= a && o.transaction_date <= b)
      .map((o) => {
        const cost = round2(o.cost_lines.reduce((acc, l) => acc + num(l.amount), 0));
        const rev = o.net_total;
        return {
          name: o.name,
          title: o.title,
          customer: o.customer_name,
          revenue: rev,
          cost,
          result: round2(rev - cost),
          margin: rev > 0 ? Math.round(((rev - cost) / rev) * 100) : null,
        };
      })
      .sort((x, y) => (x.margin ?? 999) - (y.margin ?? 999));

    // Ageing & debtors (per open invoice — includes partial invoices and excludes credited amounts)
    const ageing = { current: 0, d30: 0, d60: 0, older: 0 };
    const debtors: Record<string, any[]> = { current: [], d30: [], d60: [], older: [] };
    for (const o of s.orders) {
      if (o.docstatus !== 1) continue;
      for (const inv of ensureOrderInvoices(o)) {
        if (inv.is_return || inv.outstanding_amount <= 0.005) continue;
        const out = inv.outstanding_amount;
        const late = daysBetween(inv.due_date, today);
        const k = late <= 0 ? 'current' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : 'older';
        ageing[k] = round2(ageing[k] + out);
        debtors[k].push({
          invoice: inv.name,
          customer: o.customer,
          customer_name: o.customer_name,
          amount: out,
          late: Math.max(0, late),
        });
      }
    }

    // By payment mode
    const modeMap: Record<string, { mode: string; label: string; n: number; total: number }> = {};
    for (const p of s.payments) {
      if (p.party_type === 'Customer' && p.payment_type === 'Receive' && p.posting_date >= a && p.posting_date <= b) {
        const label = s.modes.find((m) => m.value === p.mode_of_payment)?.label || p.mode_of_payment;
        const row = (modeMap[p.mode_of_payment] ||= { mode: p.mode_of_payment, label, n: 0, total: 0 });
        row.n += 1;
        row.total = round2(row.total + p.amount);
      }
    }

    // Expense types
    const expMap: Record<string, number> = {};
    for (const e of s.expenses) {
      if (e.posting_date >= a && e.posting_date <= b) {
        expMap[e.account_name] = round2((expMap[e.account_name] || 0) + e.amount);
      }
    }
    const expense_types = Object.entries(expMap)
      .map(([name, total]) => ({ name, total }))
      .sort((x, y) => y.total - x.total)
      .slice(0, 8);

    // Purchases by supplier
    const purMap: Record<string, { supplier: string; name: string; n: number; total: number }> = {};
    for (const pi of s.supplier_invoices) {
      if (pi.posting_date >= a && pi.posting_date <= b) {
        const row = (purMap[pi.supplier] ||= { supplier: pi.supplier, name: pi.supplier_name, n: 0, total: 0 });
        row.n += 1;
        row.total = round2(row.total + pi.grand_total);
      }
    }

    // Materials used
    const matMap: Record<string, { item_code: string; name: string; uom: string; qty: number; total: number }> = {};
    for (const sm of s.stock_moves) {
      if (sm.voucher_type === 'Stock Entry' && sm.actual_qty < 0 && sm.posting_date >= a && sm.posting_date <= b) {
        const mat = s.materials.find((m) => m.item_code === sm.item_code);
        const row = (matMap[sm.item_code] ||= {
          item_code: sm.item_code,
          name: sm.item_name,
          uom: mat?.uom || '',
          qty: 0,
          total: 0,
        });
        row.qty = round2(row.qty + Math.abs(sm.actual_qty));
        row.total = round2(row.total + Math.abs(sm.stock_value_difference));
      }
    }

    // Top customers
    const custMap: Record<string, { customer: string; name: string; n: number; total: number }> = {};
    for (const o of s.orders) {
      if (o.docstatus < 2 && o.transaction_date >= a && o.transaction_date <= b) {
        const row = (custMap[o.customer] ||= { customer: o.customer, name: o.customer_name, n: 0, total: 0 });
        row.n += 1;
        row.total = round2(row.total + o.net_total);
      }
    }

    // Top services
    const srvMap: Record<string, { item_code: string; name: string; n: number; qty: number; total: number }> = {};
    for (const o of s.orders) {
      if (o.docstatus < 2 && o.transaction_date >= a && o.transaction_date <= b) {
        for (const l of o.lines) {
          const row = (srvMap[l.item_code] ||= { item_code: l.item_code, name: l.item_name, n: 0, qty: 0, total: 0 });
          row.n += 1;
          row.qty = round2(row.qty + l.qty);
          row.total = round2(row.total + num(l.amount, 0));
        }
      }
    }

    // Team performance
    const teamMap: Record<string, { name: string; role: string; done: number; open: number; late: number }> = {};
    for (const tm of s.team) {
      teamMap[tm.name] = { name: tm.name, role: tm.role, done: 0, open: 0, late: 0 };
    }
    for (const o of s.orders) {
      if (o.docstatus === 2) continue;
      for (const m of o.members) {
        const row = (teamMap[m] ||= { name: m, role: '', done: 0, open: 0, late: 0 });
        if (o.per_delivered >= 100) {
          if ((o.delivered_date || o.modified.slice(0, 10)) >= a && (o.delivered_date || o.modified.slice(0, 10)) <= b) {
            row.done += 1;
          }
        } else if (!o.archived) {
          row.open += 1;
          if (o.delivery_date && o.delivery_date < today) row.late += 1;
        }
      }
    }

    return {
      period: { kind: period, from: a, to: b, prev_from: pa, prev_to: pb },
      now,
      prev,
      months,
      profit,
      ageing,
      top_customers: Object.values(custMap).sort((x, y) => y.total - x.total).slice(0, 10),
      top_services: Object.values(srvMap).sort((x, y) => y.total - x.total).slice(0, 10),
      team: Object.values(teamMap).sort((x, y) => y.done - x.done),
      debtors,
      by_mode: Object.values(modeMap).sort((x, y) => y.total - x.total),
      expense_types,
      purchases: Object.values(purMap).sort((x, y) => y.total - x.total).slice(0, 8),
      materials: Object.values(matMap).sort((x, y) => y.total - x.total).slice(0, 10),
    };
  },
};
