import { computeCustomerBalance, getStore, round2, todayISO } from '../store.ts';

function esc(v: any): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(round2(Number(v)));
  return `<span dir="ltr" style="font-variant-numeric:tabular-nums">${n}</span> دج`;
}

function docShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/assets/atelier/atelier/fonts/cairo.css" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #F5F5F2; color: #17202A; font-family: Cairo, "Segoe UI", Tahoma, sans-serif; font-size: 14px; line-height: 1.6; }
    .bar { background: #fff; border-bottom: 1px solid #E2E4DE; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; }
    .btn { background: #0F4C81; color: #fff; border: 0; border-radius: 6px; padding: 8px 18px; font: inherit; font-weight: 600; cursor: pointer; }
    .page { max-width: 820px; margin: 24px auto; background: #fff; padding: 36px 42px; border: 1px solid #E2E4DE; border-radius: 8px; }
    .head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #0F4C81; padding-bottom: 18px; margin-bottom: 22px; }
    .brand h1 { margin: 0; font-size: 20px; color: #0F4C81; }
    .brand .fr { color: #5B646E; font-size: 13px; }
    .meta-box { text-align: left; }
    .doc-type { font-size: 20px; font-weight: 700; color: #17202A; }
    .doc-num { color: #0F4C81; font-weight: 600; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 22px; }
    .box { background: #F8F9F7; border: 1px solid #E2E4DE; border-radius: 6px; padding: 12px 14px; font-size: 13px; }
    .box b { display: block; color: #5B646E; margin-bottom: 4px; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin: 18px 0; }
    th { background: #F0F1ED; text-align: right; padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #C7CCC4; }
    td { padding: 10px 12px; border-bottom: 1px solid #E2E4DE; vertical-align: top; }
    .num { text-align: left; white-space: nowrap; }
    .totals { width: 320px; margin-right: auto; margin-top: 12px; }
    .totals tr td { padding: 6px 10px; }
    .totals .grand td { font-size: 16px; font-weight: 700; color: #0F4C81; border-top: 2px solid #0F4C81; }
    .foot { margin-top: 32px; padding-top: 14px; border-top: 1px solid #E2E4DE; font-size: 12px; color: #5B646E; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    @media print { .bar { display: none; } body { background: #fff; } .page { margin: 0; border: 0; padding: 16px; max-width: none; } }
  </style>
</head>
<body>
  <div class="bar">
    <strong>${esc(title)}</strong>
    <button class="btn" onclick="window.print()">طباعة / حفظ PDF</button>
  </div>
  <main class="page">${body}</main>
</body>
</html>`;
}

export function renderDocumentHtml(doctype: string, name: string, kind?: string): string {
  const s = getStore();
  const p = s.profile;

  if (doctype === 'Payment Entry') {
    const pe = s.payments.find((x) => x.name === name);
    if (!pe) return docShell('وصل دفع', '<p>الوصل غير موجود.</p>');
    return docShell(
      `وصل دفع ${pe.name}`,
      `<div class="head">
        <div class="brand"><h1>${esc(p.name_ar)}</h1><div class="fr">${esc(p.name_fr)}</div><div>${esc(p.address)} — ${esc(p.city)}</div><div>${esc(p.phone)}</div></div>
        <div class="meta-box"><div class="doc-type">وصل استلام</div><div class="doc-num">${esc(pe.name)}</div><div>التاريخ: ${esc(pe.posting_date)}</div></div>
      </div>
      <div class="box"><b>استُلم من</b><div><strong>${esc(pe.party_name)}</strong></div><div>طريقة الدفع: ${esc(pe.mode_of_payment)} ${pe.reference_no ? `— مرجع: ${esc(pe.reference_no)}` : ''}</div>${pe.sales_order ? `<div>عن الطلب: ${esc(pe.sales_order)}</div>` : ''}</div>
      <table class="totals"><tr class="grand"><td>المبلغ المستلم</td><td class="num">${fmtMoney(pe.amount)}</td></tr></table>
      <div class="foot"><span>${esc(s.docs.footer)}</span><span>RC: ${esc(p.rc)} · NIF: ${esc(p.nif)}</span></div>`
    );
  }

  const order =
    s.orders.find((o) => o.name === name || o.invoice_name === name || o.delivery_note === name) || s.orders[0];
  if (!order) return docShell('وثيقة', '<p>الوثيقة غير موجودة.</p>');
  const cust = s.customers.find((c) => c.name === order.customer);

  const labelMap: Record<string, string> = {
    devis: 'عرض سعر (Devis)',
    proforma: 'فاتورة أولية (Pro forma)',
    Quotation: kind === 'proforma' ? 'فاتورة أولية (Pro forma)' : 'عرض سعر (Devis)',
    'Sales Order': 'وصل طلب (Bon de commande)',
    'Delivery Note': 'وصل تسليم (Bon de livraison)',
    'Sales Invoice': 'فاتورة (Facture)',
  };
  const docTitle = labelMap[kind || doctype] || labelMap[doctype] || 'وثيقة تجارية';
  const showPrices = doctype !== 'Delivery Note';
  const tvaOn = s.docs.tva && !cust?.tva_exempt;
  const tvaAmt = tvaOn ? round2(order.net_total * ((s.docs.tva_rate || 19) / 100)) : 0;

  const rowsHtml = order.lines
    .map(
      (l, i) => `<tr>
        <td>${i + 1}</td>
        <td><strong>${esc(l.item_name)}</strong>${s.docs.show_description && l.description && l.description !== l.item_name ? `<div style="color:#5B646E;font-size:12px">${esc(l.description)}</div>` : ''}${l.size ? `<div style="color:#5B646E;font-size:12px">المقاس: ${esc(l.size)}</div>` : ''}</td>
        <td class="num">${esc(l.qty)} ${esc(l.uom)}</td>
        ${showPrices ? `<td class="num">${fmtMoney(l.rate)}</td><td class="num">${fmtMoney(l.amount)}</td>` : ''}
      </tr>`
    )
    .join('');

  return docShell(
    `${docTitle} — ${order.name}`,
    `<div class="head">
      <div class="brand">
        <h1>${esc(p.name_ar)}</h1>
        <div class="fr">${esc(p.name_fr)}</div>
        <div>${esc(p.address)} — ${esc(p.city)}</div>
        <div>${esc(p.phone)}${p.email ? ` · ${esc(p.email)}` : ''}</div>
      </div>
      <div class="meta-box">
        <div class="doc-type">${esc(docTitle)}</div>
        <div class="doc-num">${esc(doctype === 'Sales Invoice' && order.invoice_name ? order.invoice_name : order.name)}</div>
        <div>التاريخ: ${esc(order.transaction_date || todayISO())}</div>
        ${order.delivery_date ? `<div>موعد التسليم: ${esc(order.delivery_date)}</div>` : ''}
      </div>
    </div>
    <div class="grid">
      <div class="box">
        <b>العميل</b>
        <div><strong>${esc(order.customer_name)}</strong></div>
        ${cust?.address ? `<div>${esc(cust.address)} ${esc(cust.city)}</div>` : ''}
        ${cust?.mobile_no ? `<div>الهاتف: ${esc(cust.mobile_no)}</div>` : ''}
        ${cust?.tax_id ? `<div>NIF: ${esc(cust.tax_id)} ${cust.rc ? `· RC: ${esc(cust.rc)}` : ''}</div>` : ''}
      </div>
      <div class="box">
        <b>موضوع الطلب</b>
        <div><strong>${esc(order.title)}</strong></div>
        ${p.rib ? `<div>RIB: ${esc(p.rib)}</div>` : ''}
      </div>
    </div>
    <table>
      <thead><tr><th>#</th><th>البيان</th><th class="num">الكمية</th>${showPrices ? '<th class="num">سعر الوحدة</th><th class="num">المبلغ</th>' : ''}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${
      showPrices
        ? `<table class="totals">
            <tr><td>المجموع الصافي</td><td class="num">${fmtMoney(order.net_total)}</td></tr>
            ${tvaOn ? `<tr><td>TVA (${s.docs.tva_rate}%)</td><td class="num">${fmtMoney(tvaAmt)}</td></tr>` : ''}
            <tr class="grand"><td>الإجمالي للدفع</td><td class="num">${fmtMoney(order.grand_total)}</td></tr>
            ${order.paid > 0 ? `<tr><td>المدفوع / التسبيق</td><td class="num">${fmtMoney(order.paid)}</td></tr><tr><td>المتبقي</td><td class="num">${fmtMoney(Math.max(0, order.grand_total - order.paid))}</td></tr>` : ''}
          </table>`
        : ''
    }
    <div class="foot">
      <span>${esc(s.docs.footer)}</span>
      <span>RC: ${esc(p.rc)} · NIF: ${esc(p.nif)} · NIS: ${esc(p.nis)} · AI: ${esc(p.ai)}</span>
    </div>`
  );
}

export function renderStatementHtml(customerName: string): string {
  const s = getStore();
  const c = s.customers.find((x) => x.name === customerName);
  if (!c) return docShell('كشف حساب', '<p>العميل غير موجود.</p>');
  const bal = computeCustomerBalance(c.name);
  const p = s.profile;

  const lines: { date: string; ref: string; desc: string; debit: number; credit: number }[] = [];
  for (const o of s.orders) {
    if (o.customer === c.name && o.docstatus < 2 && !o.price_pending) {
      lines.push({ date: o.transaction_date, ref: o.invoice_name || o.name, desc: o.title, debit: o.grand_total, credit: 0 });
    }
  }
  for (const pay of s.payments) {
    if (pay.party_type === 'Customer' && pay.party === c.name) {
      lines.push({
        date: pay.posting_date,
        ref: pay.name,
        desc: `دفعة (${pay.mode_of_payment})`,
        debit: pay.payment_type === 'Pay' ? pay.amount : 0,
        credit: pay.payment_type === 'Receive' ? pay.amount : 0,
      });
    }
  }
  lines.sort((a, b) => a.date.localeCompare(b.date));
  let run = 0;
  const rowsHtml = lines
    .map((l) => {
      run = round2(run + l.debit - l.credit);
      return `<tr><td>${esc(l.date)}</td><td>${esc(l.ref)}</td><td>${esc(l.desc)}</td><td class="num">${l.debit ? fmtMoney(l.debit) : '—'}</td><td class="num">${l.credit ? fmtMoney(l.credit) : '—'}</td><td class="num">${fmtMoney(run)}</td></tr>`;
    })
    .join('');

  return docShell(
    `كشف حساب — ${c.customer_name}`,
    `<div class="head">
      <div class="brand"><h1>${esc(p.name_ar)}</h1><div>${esc(p.address)} — ${esc(p.city)}</div></div>
      <div class="meta-box"><div class="doc-type">كشف حساب عميل</div><div>${esc(c.customer_name)}</div><div>بتاريخ: ${esc(todayISO())}</div></div>
    </div>
    <table>
      <thead><tr><th>التاريخ</th><th>المرجع</th><th>البيان</th><th class="num">مدين</th><th class="num">دائن</th><th class="num">الرصيد</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="6">لا توجد حركات مسجلة.</td></tr>'}</tbody>
    </table>
    <table class="totals"><tr class="grand"><td>الرصيد الحالي</td><td class="num">${fmtMoney(bal.balance)}</td></tr></table>
    <div class="foot"><span>${esc(s.docs.footer)}</span><span>${esc(p.phone)}</span></div>`
  );
}
