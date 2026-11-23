import {
  AtelierError,
  daysBetween,
  getPeriodBounds,
  getPermissions,
  getStore,
  nextId,
  nowDateTime,
  num,
  parseJsonArg,
  round2,
  saveStore,
  todayISO,
} from '../store.ts';
import { MaterialItem, UserAccount } from '../types.ts';
import { boardHandlers } from './board.ts';

function computeRealCost(itemCode: string): [number | null, number] {
  const s = getStore();
  const good = s.material_cycles.filter((c) => c.item === itemCode && c.coverage >= 70 && c.recorded > 0);
  if (good.length < 3) return [null, good.length];
  const sumCost = good.reduce((a, c) => a + c.cost, 0);
  const sumRec = good.reduce((a, c) => a + c.recorded, 0);
  return [sumRec > 0 ? Math.round((sumCost / sumRec) * 10000) / 10000 : null, good.length];
}

function computeInkPerM2(): number {
  const s = getStore();
  let inkVal = 0;
  let m2 = 0;
  for (const sm of s.stock_moves) {
    if (sm.voucher_type !== 'Stock Entry' || sm.actual_qty >= 0) continue;
    const mat = s.materials.find((m) => m.item_code === sm.item_code);
    if (!mat) continue;
    if (mat.family === 'bottle') inkVal += Math.abs(sm.stock_value_difference);
    if (mat.family === 'roll') m2 += Math.abs(sm.actual_qty);
  }
  return m2 > 0 ? round2(inkVal / m2) : 180;
}

export const inventoryHandlers: Record<string, (args: Record<string, any>, user: UserAccount) => any> = {
  stock(_args, user) {
    const s = getStore();
    const can = getPermissions(user.role);
    const canValue = can.finance;

    const items = s.materials
      .filter((m) => !m.disabled)
      .map((m) => {
        const hasMoves = s.stock_moves.some((sm) => sm.item_code === m.item_code);
        const obj: any = {
          item_code: m.item_code,
          item_name: m.item_name,
          group: m.group,
          uom: m.uom,
          safety_stock: m.safety_stock,
          qty: m.qty,
          reserved: m.reserved,
          warehouses: [{ warehouse: 'مخزن المطبعة', qty: m.qty }],
          low: Boolean(m.safety_stock && m.qty < m.safety_stock),
          family: m.family,
          cfg: m.cfg,
          has_moves: hasMoves,
        };
        if (canValue) obj.value = round2(m.qty * m.valuation_rate);
        return obj;
      });

    const moves = s.stock_moves.slice(0, 20).map((m) => {
      const copy: any = { ...m };
      if (!canValue) delete copy.stock_value_difference;
      return copy;
    });

    return {
      items,
      moves,
      can_value: canValue,
      can_buy: can.finance,
      can_issue: can.stock,
      can_count: can.finance,
      can_close: user.role === 'manager',
    };
  },

  add_material(args) {
    const s = getStore();
    const name = String(args.name || '').trim();
    if (!name) throw new AtelierError('اكتب اسم المادة');
    const packs = parseJsonArg<any>(args.packs, {});
    const family = args.family || packs.way || 'count';
    const item: MaterialItem = {
      item_code: `MAT-${Date.now().toString(36).toUpperCase()}`,
      item_name: name,
      group: packs.section || 'أخرى',
      uom: args.uom || (family === 'roll' ? 'م²' : family === 'bottle' ? 'لتر' : 'ورقة'),
      safety_stock: num(args.min_qty, 0),
      qty: 0,
      reserved: 0,
      valuation_rate: 0,
      family,
      cfg: {
        section: packs.section || 'أخرى',
        way: family,
        kind: packs.kind || '',
        size: packs.size || '',
        gsm: num(packs.gsm, 0),
        width: num(packs.width, 0),
        length: num(packs.length, 0),
        pack: packs.pack || (family === 'roll' ? 'لفّة' : family === 'bottle' ? 'قارورة' : 'رزمة'),
        pack_qty: num(packs.pack_qty, 1),
        waste: num(packs.waste, 5),
        closed: num(packs.closed, 0),
        open_since: null,
        open_cost: 0,
      },
    };
    s.materials.push(item);
    saveStore();
    return item.item_code;
  },

  update_material(args) {
    const s = getStore();
    const m = s.materials.find((x) => x.item_code === args.item_code);
    if (!m) throw new AtelierError('المادة غير موجودة', 404);
    if (args.name) m.item_name = String(args.name).trim();
    if (args.min_qty !== undefined) m.safety_stock = num(args.min_qty, 0);
    if (args.uom) m.uom = String(args.uom);
    if (args.family) m.family = String(args.family);
    if (args.packs) {
      const packs = parseJsonArg<any>(args.packs, {});
      m.cfg = { ...m.cfg, ...packs };
      if (packs.section) m.group = packs.section;
    }
    saveStore();
    return { ok: true };
  },

  remove_material(args) {
    const s = getStore();
    const m = s.materials.find((x) => x.item_code === args.item_code);
    if (!m) throw new AtelierError('المادة غير موجودة', 404);
    m.disabled = 1;
    saveStore();
    return { ok: true };
  },

  stock_purchase(args, user) {
    const s = getStore();
    const m = s.materials.find((x) => x.item_code === args.item_code);
    if (!m) throw new AtelierError('المادة غير موجودة', 404);
    const rawQty = num(args.qty, 0);
    const rawRate = num(args.rate, 0);
    if (rawQty <= 0) throw new AtelierError('الكمية يجب أن تكون أكبر من صفر');
    const packQty = m.cfg.pack_qty > 0 ? m.cfg.pack_qty : 1;
    const isPack = Boolean(args.uom && args.uom !== m.uom && packQty > 1);
    const conv = isPack ? packQty : 1;
    const stockQty = round2(rawQty * conv);
    const amount = round2(rawQty * rawRate);
    const stockRate = stockQty > 0 ? round2(amount / stockQty) : rawRate;
    const oldVal = m.qty * m.valuation_rate;
    m.qty = round2(m.qty + stockQty);
    if (m.qty > 0 && stockRate > 0) m.valuation_rate = round2((oldVal + amount) / m.qty);
    if (isPack) {
      m.cfg.closed = Math.max(0, (m.cfg.closed || 0) + Math.floor(rawQty));
    } else if (m.cfg.pack_qty > 0 && stockQty >= m.cfg.pack_qty) {
      m.cfg.closed = Math.max(0, (m.cfg.closed || 0) + Math.floor(stockQty / m.cfg.pack_qty));
    }
    const invName = nextId('PI');
    const sup = s.suppliers.find((x) => x.name === args.supplier || x.supplier_name === args.supplier);
    if (sup) {
      s.supplier_invoices.unshift({
        name: invName,
        supplier: sup.name,
        supplier_name: sup.supplier_name,
        posting_date: todayISO(),
        due_date: todayISO(),
        net_total: amount,
        tva_rate: 0,
        tva_amount: 0,
        grand_total: amount,
        outstanding_amount: amount,
        bill_no: String(args.bill_no || ''),
        order_name: null,
        what: `${m.item_name} (${rawQty} ${isPack ? args.uom : m.uom})`,
        account: 'EXP-OFFICE',
        items: [{ item_code: m.item_code, item_name: m.item_name, description: m.item_name, qty: rawQty, rate: rawRate, amount, uom: isPack ? String(args.uom) : m.uom, conversion_factor: conv, is_stock: 1 }],
        docstatus: 1,
      });
    }
    s.stock_moves.unshift({
      id: `SM-${Date.now()}`,
      posting_date: todayISO(),
      creation: nowDateTime(),
      item_code: m.item_code,
      item_name: m.item_name,
      warehouse: 'مخزن المطبعة',
      actual_qty: stockQty,
      voucher_type: 'Purchase Invoice',
      voucher_no: invName,
      stock_value_difference: amount,
      uom: isPack ? String(args.uom) : m.uom,
      conversion_factor: conv,
      buy_rate: rawRate,
      supplier_name: sup?.supplier_name || '',
      owner: user.email,
    });
    saveStore();
    return { name: invName, qty: m.qty };
  },

  stock_issue(args, user) {
    const s = getStore();
    const m = s.materials.find((x) => x.item_code === args.item_code);
    if (!m) throw new AtelierError('المادة غير موجودة', 404);
    const qty = num(args.qty, 0);
    if (qty <= 0) throw new AtelierError('الكمية يجب أن تكون أكبر من صفر');
    const val = round2(qty * m.valuation_rate);
    m.qty = round2(Math.max(0, m.qty - qty));
    const ord = args.sales_order ? s.orders.find((o) => o.name === args.sales_order) : null;
    const steName = nextId('STE');
    s.stock_moves.unshift({
      id: `SM-${Date.now()}`,
      posting_date: todayISO(),
      creation: nowDateTime(),
      item_code: m.item_code,
      item_name: m.item_name,
      warehouse: 'مخزن المطبعة',
      actual_qty: -qty,
      voucher_type: 'Stock Entry',
      voucher_no: steName,
      stock_value_difference: -val,
      order: ord?.name || null,
      order_title: ord?.title || null,
      note: String(args.note || ''),
      owner: user.email,
    });
    saveStore();
    return { name: steName, qty: m.qty };
  },

  stock_count(args, user) {
    const s = getStore();
    const m = s.materials.find((x) => x.item_code === args.item_code);
    if (!m) throw new AtelierError('المادة غير موجودة', 404);
    const newQty = Math.max(0, num(args.qty, 0));
    const diff = round2(newQty - m.qty);
    if (args.rate != null && args.rate !== '') m.valuation_rate = num(args.rate, m.valuation_rate);
    m.qty = round2(newQty);
    s.stock_moves.unshift({
      id: `SM-${Date.now()}`,
      posting_date: todayISO(),
      creation: nowDateTime(),
      item_code: m.item_code,
      item_name: m.item_name,
      warehouse: 'مخزن المطبعة',
      actual_qty: diff,
      voucher_type: 'Stock Reconciliation',
      voucher_no: nextId('STE'),
      stock_value_difference: round2(diff * m.valuation_rate),
      note: 'جرد وتعديل الكمية',
      owner: user.email,
    });
    saveStore();
    return { qty: m.qty };
  },

  set_closed_packs(args) {
    const s = getStore();
    const m = s.materials.find((x) => x.item_code === args.item_code);
    if (!m) throw new AtelierError('المادة غير موجودة', 404);
    m.cfg.closed = Math.max(0, Math.trunc(num(args.n, 0)));
    saveStore();
    return { closed: m.cfg.closed };
  },

  pack_cycle(args) {
    const s = getStore();
    const m = s.materials.find((x) => x.item_code === args.item_code);
    if (!m) throw new AtelierError('المادة غير موجودة', 404);
    const since = m.cfg.open_since || todayISO();
    const moves = s.stock_moves.filter(
      (sm) => sm.item_code === m.item_code && sm.voucher_type === 'Stock Entry' && sm.actual_qty < 0 && sm.posting_date >= since
    );
    const recorded = round2(moves.reduce((a, x) => a + Math.abs(x.actual_qty), 0));
    const size = m.cfg.pack_qty || 1;
    const gap = round2(Math.max(0, size - recorded));
    const coverage = size > 0 ? Math.min(100, Math.round((recorded / size) * 1000) / 10) : 0;
    const issuedOrderIds = new Set(moves.map((x) => x.order).filter(Boolean));
    const candidates = s.orders
      .filter((o) => o.docstatus < 2 && o.transaction_date >= since && !issuedOrderIds.has(o.name))
      .map((o) => {
        let estQty = 0;
        for (const l of o.lines) {
          if (l.material === m.item_code) {
            estQty += l.qty;
          } else {
            const srv = s.services.find((sv) => sv.item_code === l.item_code);
            const rec = (srv?.recipe || []).find((r) => r.item_code === m.item_code);
            if (rec) estQty += rec.qty * l.qty;
          }
        }
        return estQty > 0 ? { order: o.name, title: o.title, qty: round2(estQty), checked: false } : null;
      })
      .filter(Boolean);

    return {
      item_code: m.item_code,
      item_name: m.item_name,
      pack: m.cfg.pack || (m.family === 'roll' ? 'لفّة' : 'رزمة'),
      size,
      uom: m.uom,
      since,
      opened_on: since,
      used: recorded,
      recorded,
      gap,
      coverage,
      closed: m.cfg.closed || 0,
      cost: m.cfg.open_cost || round2(size * m.valuation_rate),
      orders: moves
        .filter((x) => x.order)
        .map((x) => ({ order: x.order, title: x.order_title || x.order, qty: Math.abs(x.actual_qty) })),
      candidates,
    };
  },

  close_pack(args, user) {
    const s = getStore();
    const m = s.materials.find((x) => x.item_code === args.item_code);
    if (!m) throw new AtelierError('المادة غير موجودة', 404);
    const extraOrders = parseJsonArg<any[]>(args.orders, []);
    for (const eo of extraOrders) {
      if (eo?.order && num(eo.qty) > 0) {
        inventoryHandlers.stock_issue({ item_code: m.item_code, qty: eo.qty, sales_order: eo.order, note: 'خصم عند إغلاق العبوة' }, user);
      }
    }
    const info = inventoryHandlers.pack_cycle(args, user);
    const waste = round2(Math.max(0, info.size - info.recorded));
    if (waste > 0.005) {
      m.qty = round2(Math.max(0, m.qty - waste));
    }
    s.material_cycles.unshift({
      id: `CYC-${Date.now().toString(36)}`,
      item: m.item_code,
      opened_on: info.opened_on,
      closed_on: todayISO(),
      size: info.size,
      cost: info.cost,
      recorded: info.recorded,
      gap: waste,
      coverage: info.coverage,
      orders: info.orders,
    });
    m.cfg.open_since = null;
    if (m.cfg.closed > 0) {
      m.cfg.closed -= 1;
      m.cfg.open_since = todayISO();
      m.cfg.open_cost = round2((m.cfg.pack_qty || 1) * m.valuation_rate);
    }
    saveStore();
    return { ok: true, waste, gap: waste, coverage: info.coverage };
  },

  open_pack(args) {
    const s = getStore();
    const m = s.materials.find((x) => x.item_code === args.item_code);
    if (!m) throw new AtelierError('المادة غير موجودة', 404);
    if (m.cfg.closed > 0) m.cfg.closed -= 1;
    m.cfg.open_since = todayISO();
    m.cfg.open_cost = round2((m.cfg.pack_qty || 1) * m.valuation_rate);
    saveStore();
    return { open_since: m.cfg.open_since, closed: m.cfg.closed, gap: 0 };
  },

  recipes() {
    const s = getStore();
    return {
      services: s.services
        .filter((x) => !x.disabled)
        .map((x) => ({ item_code: x.item_code, item_name: x.item_name, stock_uom: x.stock_uom, recipe: x.recipe || [] })),
      materials: s.materials
        .filter((x) => !x.disabled)
        .map((x) => ({ item_code: x.item_code, item_name: x.item_name, stock_uom: x.uom })),
    };
  },

  save_recipe(args) {
    const s = getStore();
    const srv = s.services.find((x) => x.item_code === args.item_code);
    if (!srv) throw new AtelierError('الخدمة غير موجودة', 404);
    const rows = parseJsonArg<any[]>(args.rows, []);
    const parseQty = (v: any) => num(String(v ?? '').trim().replace(/\s/g, '').replace(',', '.'), 0);
    srv.recipe = rows
      .filter((r) => r.item_code && parseQty(r.qty) > 0)
      .map((r) => ({ item_code: r.item_code, qty: Math.round(parseQty(r.qty) * 10000) / 10000 }));
    saveStore();
    return srv.recipe;
  },

  material_ledger(args) {
    const s = getStore();
    const m = s.materials.find((x) => x.item_code === args.item_code);
    if (!m) throw new AtelierError('المادة غير موجودة', 404);
    const limit = num(args.limit, 60);

    const allMoves = s.stock_moves
      .filter((sm) => sm.item_code === m.item_code)
      .sort((a, b) => (b.posting_date + b.creation).localeCompare(a.posting_date + a.creation));

    // Compute running balance backward from current m.qty so qty_after_transaction matches live stock
    let running = m.qty;
    const rows = allMoves.slice(0, limit).map((sm) => {
      const row = { ...sm, qty_after_transaction: round2(running) };
      running = round2(Math.max(0, running - sm.actual_qty));
      return row;
    });

    const today = todayISO();
    const monthStart = today.slice(0, 7) + '-01';
    const d30 = new Date(today + 'T00:00:00Z');
    d30.setUTCDate(d30.getUTCDate() - 30);
    const since30 = d30.toISOString().slice(0, 10);

    const monthUsed = round2(
      allMoves
        .filter((sm) => sm.voucher_type === 'Stock Entry' && sm.actual_qty < 0 && sm.posting_date >= monthStart)
        .reduce((a, sm) => a + Math.abs(sm.actual_qty), 0)
    );
    const used30 = allMoves
      .filter((sm) => sm.voucher_type === 'Stock Entry' && sm.actual_qty < 0 && sm.posting_date >= since30)
      .reduce((a, sm) => a + Math.abs(sm.actual_qty), 0);
    const daily = used30 > 0 ? round2(used30 / 30) : 0;

    const [realCost, goodCycles] = computeRealCost(m.item_code);
    const cycles = s.material_cycles.filter((c) => c.item === m.item_code);

    // Find latest purchase invoice / stock purchase for last_buy metadata
    let lastBuy: any = null;
    const lastBuyMove = allMoves.find((sm) => sm.voucher_type === 'Purchase Invoice');
    if (lastBuyMove) {
      const pi = s.supplier_invoices.find((i) => i.name === lastBuyMove.voucher_no);
      const piItem = pi?.items?.find((it) => it.item_code === m.item_code);
      const conv = lastBuyMove.conversion_factor || piItem?.conversion_factor || 1;
      const buyRate =
        lastBuyMove.buy_rate ??
        piItem?.rate ??
        (lastBuyMove.actual_qty > 0 ? round2(lastBuyMove.stock_value_difference / lastBuyMove.actual_qty) : m.valuation_rate);
      lastBuy = {
        posting_date: lastBuyMove.posting_date,
        rate: buyRate,
        uom: lastBuyMove.uom || piItem?.uom || m.uom,
        conversion_factor: conv,
        stock_rate: conv > 1 ? round2(buyRate / conv) : buyRate,
        supplier_name: lastBuyMove.supplier_name || pi?.supplier_name || '',
      };
    }

    return {
      rows,
      daily,
      month_used: monthUsed,
      real_cost: realCost,
      good_cycles: goodCycles,
      cycles,
      last_buy: lastBuy,
    };
  },

  order_materials(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.order);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const needed: Record<string, number> = {};
    for (const l of o.lines) {
      const srv = s.services.find((x) => x.item_code === l.item_code);
      for (const r of srv?.recipe || []) {
        needed[r.item_code] = round2((needed[r.item_code] || 0) + r.qty * l.qty);
      }
    }
    const rows = Object.entries(needed)
      .map(([code, need]) => {
        const m = s.materials.find((x) => x.item_code === code);
        if (!m) return null;
        return { item_code: m.item_code, item_name: m.item_name, uom: m.uom, need, on_hand: m.qty };
      })
      .filter(Boolean);

    return {
      rows,
      done: o.materials_done,
      delivered: o.per_delivered >= 100,
      title: o.title,
      outsourced: o.outsourced,
    };
  },

  skip_materials(args) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.order);
    if (o) {
      o.materials_done = 1;
      saveStore();
    }
    return { ok: true };
  },

  issue_order_materials(args, user) {
    const s = getStore();
    const o = s.orders.find((x) => x.name === args.order);
    if (!o) throw new AtelierError('الطلب غير موجود', 404);
    const rows = parseJsonArg<any[]>(args.rows, []);
    for (const r of rows) {
      if (r.item_code && num(r.qty) > 0) {
        inventoryHandlers.stock_issue({ item_code: r.item_code, qty: r.qty, sales_order: o.name }, user);
      }
    }
    o.materials_done = 1;
    saveStore();
    return { ok: true };
  },

  materials_report(args) {
    const s = getStore();
    const [a, b] = getPeriodBounds(args.period || 'month', args.start, args.end);

    let printedM2 = 0;
    const rows: any[] = s.materials
      .filter((m) => !m.disabled)
      .map((m) => {
        const usedMoves = s.stock_moves.filter(
          (sm) => sm.item_code === m.item_code && sm.voucher_type === 'Stock Entry' && sm.actual_qty < 0 && sm.posting_date >= a && sm.posting_date <= b
        );
        const used = round2(usedMoves.reduce((acc, x) => acc + Math.abs(x.actual_qty), 0));
        const usedVal = round2(usedMoves.reduce((acc, x) => acc + Math.abs(x.stock_value_difference), 0));
        if (m.family === 'roll') printedM2 += used;

        const cycs = s.material_cycles.filter((c) => c.item === m.item_code && c.closed_on >= a && c.closed_on <= b);
        const goodCycs = cycs.filter((c) => c.coverage >= 70);
        const weakCycs = cycs.filter((c) => c.coverage < 70);
        const gap = round2(goodCycs.reduce((acc, c) => acc + Math.max(0, c.gap), 0));
        const size = goodCycs.reduce((acc, c) => acc + c.size, 0);
        const gapVal = round2(goodCycs.reduce((acc, c) => acc + Math.max(0, c.gap) * (c.size ? c.cost / c.size : 0), 0));
        const weak = round2(weakCycs.reduce((acc, c) => acc + Math.max(0, c.gap), 0));
        const weakVal = round2(weakCycs.reduce((acc, c) => acc + Math.max(0, c.gap) * (c.size ? c.cost / c.size : 0), 0));

        const [real, goodAll] = computeRealCost(m.item_code);
        const unit = m.valuation_rate;

        return {
          item_code: m.item_code,
          item_name: m.item_name,
          uom: m.uom,
          way: m.family,
          used,
          used_value: usedVal,
          cycles: cycs.length,
          good: goodCycs.length,
          waste: gap,
          waste_pct: size > 0 ? Math.round((gap / size) * 1000) / 10 : null,
          waste_value: gapVal,
          weak,
          weak_value: weakVal,
          unit_buy: unit,
          unit_real: real,
          good_all: goodAll,
          diff_pct: real && unit ? Math.round(((real - unit) / unit) * 1000) / 10 : null,
          stock_value: round2(m.qty * m.valuation_rate),
          low: Boolean(m.safety_stock && m.qty < m.safety_stock),
        };
      });

    const ink = rows.filter((r) => r.way === 'bottle').reduce((acc, r) => acc + r.used_value, 0);
    for (const r of rows) {
      if (r.way === 'bottle') r.per_m2 = printedM2 > 0 ? round2(r.used_value / printedM2) : null;
    }
    rows.sort((x, y) => y.waste_value - x.waste_value || y.used_value - x.used_value);

    return {
      from: a,
      to: b,
      rows,
      used_value: round2(rows.reduce((acc, r) => acc + r.used_value, 0)),
      waste_value: round2(rows.reduce((acc, r) => acc + r.waste_value, 0)),
      weak_value: round2(rows.reduce((acc, r) => acc + r.weak_value, 0)),
      cycles: rows.reduce((acc, r) => acc + r.cycles, 0),
      good: rows.reduce((acc, r) => acc + r.good, 0),
      stock_value: round2(rows.reduce((acc, r) => acc + r.stock_value, 0)),
      low: rows.filter((r) => r.low).length,
      ink_per_m2: printedM2 > 0 ? round2(ink / printedM2) : computeInkPerM2(),
    };
  },

  material_detail(args) {
    const s = getStore();
    const m = s.materials.find((x) => x.item_code === args.item_code);
    if (!m) throw new AtelierError('المادة غير موجودة', 404);
    const size = m.cfg.pack_qty > 0 ? m.cfg.pack_qty : 1;
    const cycles = s.material_cycles
      .filter((c) => c.item === m.item_code)
      .map((c) => ({
        opened_on: c.opened_on,
        closed_on: c.closed_on,
        size: c.size,
        cost: c.cost,
        recorded: c.recorded,
        gap: c.gap,
        coverage: c.coverage,
        days: c.opened_on && c.closed_on ? daysBetween(c.opened_on, c.closed_on) : null,
        n_orders: c.orders.length,
        real: c.recorded > 0 && c.coverage >= 70 ? Math.round((c.cost / c.recorded) * 10000) / 10000 : null,
      }));

    const buys: any[] = [];
    for (const pi of s.supplier_invoices) {
      for (const it of pi.items || []) {
        if (it.item_code === m.item_code) {
          buys.push({
            posting_date: pi.posting_date,
            supplier_name: pi.supplier_name,
            unit: it.rate,
            per_pack: round2(it.rate * size),
          });
        }
      }
    }
    return { pack: m.cfg.pack || '', size, uom: m.uom, cycles, buys };
  },

  pricing_info() {
    const s = getStore();
    const real: Record<string, number> = {};
    for (const m of s.materials) {
      const [r] = computeRealCost(m.item_code);
      if (r !== null) real[m.item_code] = r;
    }
    return { target: s.target_margin || 30, ink_per_m2: computeInkPerM2(), real };
  },

  set_target_margin(args) {
    const s = getStore();
    const raw = String(args.value ?? '').trim().replace(/\s/g, '').replace(',', '.');
    const parsed = Number(raw);
    if (raw === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > 90) {
      throw new AtelierError('أدخل هامشًا صحيحًا بين 0% و 90%');
    }
    s.target_margin = round2(parsed);
    saveStore();
    return s.target_margin;
  },

  profit_report(args) {
    const s = getStore();
    const [a, b] = getPeriodBounds(args.period || 'month', args.start, args.end);
    const info = inventoryHandlers.pricing_info({}, {} as UserAccount);
    const target = info.target;

    const orders = s.orders.filter(
      (o) =>
        o.docstatus === 1 &&
        !o.price_pending &&
        (o.net_total > 0 || (o.returned_net || 0) > 0) &&
        o.transaction_date >= a &&
        o.transaction_date <= b
    );

    const rows = orders.map((o) => {
      let mat = 0;
      let sup = 0;
      let other = 0;
      let m2 = 0;

      for (const sm of s.stock_moves) {
        if (sm.order === o.name && sm.voucher_type === 'Stock Entry' && sm.actual_qty < 0) {
          const item = s.materials.find((m) => m.item_code === sm.item_code);
          const qty = Math.abs(sm.actual_qty);
          const real = info.real[sm.item_code];
          mat += real ? qty * real : Math.abs(sm.stock_value_difference);
          if (item?.family === 'roll') m2 += qty;
        }
      }

      for (const cl of o.cost_lines) {
        if (cl.cost_type === 'Sous-traitance') sup += num(cl.amount);
        else if (cl.cost_type === 'Matière') {
          if (mat === 0) mat += num(cl.amount);
        } else {
          other += num(cl.amount);
        }
      }

      const ink = round2(m2 * info.ink_per_m2);
      const parts = { materials: round2(mat), supplier: round2(sup), recipes: 0, ink, other: round2(other) };
      const cost = round2(parts.materials + parts.supplier + parts.recipes + parts.ink + parts.other);
      // True net sale after credit notes / returns
      const returned = round2(o.returned_net || 0);
      const sale = round2(Math.max(0, o.net_total));
      const hasCost = cost > 0;
      const profitVal = hasCost ? round2(sale - cost) : null;
      const marginVal =
        hasCost && sale > 0
          ? Math.round(((sale - cost) / sale) * 1000) / 10
          : hasCost && sale === 0 && cost > 0
          ? -100
          : null;
      return {
        order: o.name,
        title: o.title,
        customer: o.customer_name,
        date: o.transaction_date,
        sale,
        returned,
        cost,
        parts,
        m2: round2(m2),
        profit: profitVal,
        margin: marginVal,
      };
    });

    const costed = rows.filter((r) => r.margin !== null);
    rows.sort((x, y) => (x.margin === null ? 1 : y.margin === null ? -1 : x.margin - y.margin));
    const saleC = round2(costed.reduce((acc, r) => acc + r.sale, 0));
    const costC = round2(costed.reduce((acc, r) => acc + r.cost, 0));
    const under = costed.filter((r) => (r.margin ?? 100) < target);

    return {
      target,
      ink_per_m2: info.ink_per_m2,
      rows,
      sales: round2(rows.reduce((acc, r) => acc + r.sale, 0)),
      returned: round2(rows.reduce((acc, r) => acc + r.returned, 0)),
      orders: rows.length,
      costed: costed.length,
      sales_costed: saleC,
      cost: costC,
      parts: {
        materials: round2(costed.reduce((acc, r) => acc + r.parts.materials, 0)),
        supplier: round2(costed.reduce((acc, r) => acc + r.parts.supplier, 0)),
        recipes: 0,
        ink: round2(costed.reduce((acc, r) => acc + r.parts.ink, 0)),
        other: round2(costed.reduce((acc, r) => acc + r.parts.other, 0)),
      },
      profit: round2(saleC - costC),
      margin: saleC > 0 ? Math.round(((saleC - costC) / saleC) * 1000) / 10 : null,
      under: under.length,
      from: a,
      to: b,
    };
  },

  services_overview(_args, user) {
    const s = getStore();
    const info = inventoryHandlers.pricing_info({}, user);
    const target = info.target;
    const areaUnits = new Set(s.units.filter((u) => u.calc === 'area').map((u) => u.name));

    const now = new Date();
    const keys: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      keys.push(d.toISOString().slice(0, 7));
    }
    const since90Date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 90));
    const since90 = since90Date.toISOString().slice(0, 10);

    const items = s.services
      .filter((srv) => !srv.disabled)
      .map((srv) => {
        const parts: any[] = [];
        let cost: number | null = null;
        if (srv.recipe && srv.recipe.length) {
          cost = 0;
          for (const r of srv.recipe) {
            const m = s.materials.find((x) => x.item_code === r.item_code);
            if (!m) continue;
            const real = info.real[m.item_code];
            const unit = real || m.valuation_rate;
            const amount = round2(r.qty * unit);
            cost = round2(cost + amount);
            parts.push({ label: m.item_name, qty: r.qty, uom: m.uom, unit, real: Boolean(real), amount });
          }
          if (areaUnits.has(srv.stock_uom) && info.ink_per_m2) {
            parts.push({ label: 'حبر (تقدير)', qty: 1, uom: srv.stock_uom, unit: info.ink_per_m2, real: false, amount: info.ink_per_m2, estimate: true });
            cost = round2(cost + info.ink_per_m2);
          }
        }
        const price = srv.price_company ?? srv.price_individual;
        const margin = cost !== null && price && price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : null;

        let ordersCount = 0;
        let qtySum = 0;
        let amtSum = 0;
        const mMap: Record<string, number> = {};
        const topCust: Record<string, number> = {};
        for (const o of s.orders) {
          if (o.docstatus === 2) continue;
          const matching = o.lines.filter((l) => l.item_code === srv.item_code && !l.price_pending && num(l.amount, 0) > 0);
          if (!matching.length) continue;
          const ym = o.transaction_date.slice(0, 7);
          const in3m = o.transaction_date >= since90;
          if (in3m) {
            ordersCount++;
            topCust[o.customer_name] = (topCust[o.customer_name] || 0) + 1;
          }
          for (const l of matching) {
            const a = num(l.amount, 0);
            mMap[ym] = round2((mMap[ym] || 0) + a);
            if (in3m) {
              qtySum += num(l.qty, 0);
              amtSum += a;
            }
          }
        }
        const topEntry = Object.entries(topCust).sort((x, y) => y[1] - x[1])[0];

        return {
          item_code: srv.item_code,
          item_name: srv.item_name,
          stock_uom: srv.stock_uom,
          atelier_category: srv.atelier_category,
          is_stock_item: srv.is_stock_item,
          price_individual: srv.price_individual,
          price_company: srv.price_company,
          cost,
          parts,
          margin,
          min_price: cost !== null && cost > 0 && target < 100 ? round2(cost / (1 - target / 100)) : null,
          sales: ordersCount ? { orders: ordersCount, qty: round2(qtySum), amount: round2(amtSum), avg: qtySum > 0 ? round2(amtSum / qtySum) : 0 } : null,
          months: keys.map((k) => mMap[k] || 0),
          top: topEntry ? { customer: topEntry[0], orders: topEntry[1] } : null,
        };
      });

    return { items, target, months: keys, keys, can_edit: user.role === 'manager' };
  },

  // ------------------------------------------------------------------ Prices & Services
  prices(_args, user) {
    const s = getStore();
    return {
      items: s.services.filter((i) => !i.disabled),
      lists: { Individual: 'سعر الأفراد', Company: 'سعر المؤسسات' },
      can_edit: user.role === 'manager',
    };
  },

  set_price(args) {
    const s = getStore();
    const srv = s.services.find((i) => i.item_code === args.item_code);
    if (!srv) throw new AtelierError('الخدمة غير موجودة', 404);
    const val = args.rate === '' || args.rate === null || args.rate === undefined ? null : round2(num(args.rate));
    if (args.kind === 'Company') srv.price_company = val;
    else srv.price_individual = val;
    if (val !== null) srv.standard_rate = val;
    saveStore();
    return val;
  },

  set_item_category(args) {
    const s = getStore();
    const srv = s.services.find((i) => i.item_code === args.item_code);
    if (!srv) throw new AtelierError('الخدمة غير موجودة', 404);
    srv.atelier_category = String(args.category || '');
    srv.item_group = srv.atelier_category || srv.item_group;
    saveStore();
    return srv.atelier_category || null;
  },

  create_item(args) {
    const s = getStore();
    const d = parseJsonArg<any>(args.data ?? args, {});
    const name = String(d.item_name || '').trim();
    if (!name) throw new AtelierError('اكتب اسم الخدمة');
    const code = `SRV-${Date.now().toString(36).toUpperCase()}`;
    const parseOptPrice = (v: any) => {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) throw new AtelierError('سعر غير صحيح');
      return round2(n);
    };
    const ind = parseOptPrice(d.price_individual);
    const comp = parseOptPrice(d.price_company);
    const cat = String(d.category ?? d.atelier_category ?? '').trim();
    const item = {
      item_code: code,
      item_name: name,
      item_group: cat || 'طباعة رقمية',
      stock_uom: String(d.uom || d.stock_uom || 'قطعة').trim(),
      atelier_category: cat,
      is_stock_item: d.kind === 'product' ? 1 : 0,
      standard_rate: comp ?? ind ?? 0,
      price_individual: ind,
      price_company: comp,
      recipe: [],
    };
    s.services.push(item);
    saveStore();
    return item;
  },

  update_item(args) {
    const s = getStore();
    const d = parseJsonArg<any>(args.data ?? args, {});
    const code = String(d.item_code || args.item_code || '').trim();
    const srv = s.services.find((i) => i.item_code === code);
    if (!srv) throw new AtelierError('الخدمة غير موجودة', 404);
    const name = String(d.item_name ?? srv.item_name).trim();
    if (!name) throw new AtelierError('اكتب اسم الخدمة');
    const parseOptPrice = (v: any) => {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) throw new AtelierError('سعر غير صحيح');
      return round2(n);
    };
    srv.item_name = name;
    if (d.uom || d.stock_uom) srv.stock_uom = String(d.uom || d.stock_uom).trim();
    if (d.category !== undefined || d.atelier_category !== undefined) {
      srv.atelier_category = String(d.category ?? d.atelier_category ?? '').trim();
      if (srv.atelier_category) srv.item_group = srv.atelier_category;
    }
    if (d.kind !== undefined) srv.is_stock_item = d.kind === 'product' ? 1 : 0;
    if (d.price_individual !== undefined) srv.price_individual = parseOptPrice(d.price_individual);
    if (d.price_company !== undefined) srv.price_company = parseOptPrice(d.price_company);
    srv.standard_rate = srv.price_company ?? srv.price_individual ?? 0;
    saveStore();
    return srv;
  },

  delete_item(args) {
    const s = getStore();
    const srv = s.services.find((i) => i.item_code === args.item_code);
    if (!srv) throw new AtelierError('الخدمة غير موجودة', 404);
    srv.disabled = 1;
    saveStore();
    return { ok: true };
  },

  // ------------------------------------------------------------------ Cost Calculator
  calc_data(_args, user) {
    const s = getStore();
    const areaRe = /م²|m²|سم²/i;
    return {
      services: s.services
        .filter((i) => !i.disabled)
        .map((i) => ({
          item_code: i.item_code,
          item_name: i.item_name,
          stock_uom: i.stock_uom,
          price_individual: i.price_individual,
          price_company: i.price_company,
          recipe: i.recipe || [],
          area: areaRe.test(i.stock_uom) ? 1 : 0,
        })),
      materials: s.materials
        .filter((m) => !m.disabled)
        .map((m) => ({
          item_code: m.item_code,
          item_name: m.item_name,
          stock_uom: m.uom,
          rate: m.valuation_rate || null,
        })),
      cost_types: (s.lists.cost_types || []).map((t: any) => ({
        value: t.value,
        label: t.label,
        material: t.material ? 1 : 0,
      })),
      margins: s.margins,
      saved: s.calcs.map((c) => ({ id: c.id, title: c.title, at: c.at, by: c.by })),
      can_price: user.role === 'manager',
    };
  },

  save_margins(args) {
    const s = getStore();
    const d = parseJsonArg<any>(args.data, {});
    s.margins = {
      individual: Math.max(0, Math.min(90, num(d.individual, s.margins.individual))),
      company: Math.max(0, Math.min(90, num(d.company, s.margins.company))),
      reseller: Math.max(0, Math.min(90, num(d.reseller, s.margins.reseller))),
    };
    saveStore();
    return s.margins;
  },

  save_calc(args, user) {
    const s = getStore();
    const d = parseJsonArg<any>(args.data, {});
    const id = args.id || nextId('CALC');
    const row = {
      id,
      title: String(d.title || 'حساب تكلفة').trim(),
      item_code: d.item_code || null,
      qty: num(d.qty, 1),
      width: num(d.width, 0),
      height: num(d.height, 0),
      waste_percent: num(d.waste_percent, 0),
      lines: (d.lines || []).map((l: any) => ({
        cost_type: l.cost_type || 'Autre',
        description: String(l.description || ''),
        item: l.item || null,
        qty: num(l.qty, 1),
        rate: l.rate != null && l.rate !== '' ? num(l.rate) : null,
        amount: round2(num(l.qty, 1) * num(l.rate, 0)),
        source: l.source || '',
      })),
      at: nowDateTime(),
      by: user.full_name,
    };
    const idx = s.calcs.findIndex((x) => x.id === id);
    if (idx >= 0) s.calcs[idx] = row;
    else s.calcs.unshift(row);
    saveStore();
    return row;
  },

  get_calc(args) {
    const s = getStore();
    const c = s.calcs.find((x) => x.id === args.id);
    if (!c) throw new AtelierError('الحساب غير موجود', 404);
    return c;
  },

  delete_calc(args) {
    const s = getStore();
    s.calcs = s.calcs.filter((x) => x.id !== args.id);
    saveStore();
    return { ok: true };
  },

  calc_order(args, user) {
    const d = parseJsonArg<any>(args.data, {});
    const qty = Math.max(1, num(d.qty, 1));
    const rate = num(args.rate, 0);
    return boardHandlers.quick_order(
      {
        data: {
          customer: args.customer || 'CUS-CASH',
          title: d.title || 'طلب من حاسبة التكلفة',
          column: args.column || undefined,
          lines: [
            {
              item_code: d.item_code || 'SRV-GENERAL',
              item_name: d.title || 'طلب من حاسبة التكلفة',
              qty,
              rate,
            },
          ],
        },
      },
      user
    );
  },
};
