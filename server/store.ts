import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import path from 'path';
import { createSeedData } from './seed.ts';
import {
  ShardName,
  computeShardHashes,
  diffChangedShards,
  mergeShardsToStore,
} from './shards.ts';
import { AppRole, OrderInvoiceRecord, OrderRecord, StoreData, UserAccount } from './types.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'atelier-store.json');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

export class AtelierError extends Error {
  status: number;
  errors?: Record<string, string>;
  constructor(message: string, status = 417, errors?: Record<string, string>) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export interface TenantRuntimeEntry {
  tenantId: string;
  store: StoreData;
  version: number;
  shardHashes: Record<ShardName, string>;
  filesData: Map<string, { mimeType: string; dataUrl: string }>;
  hydratedAt: number;
  authorizedUids: Set<string>;
}

interface TenantRequestContext {
  tenantId: string;
  entry: TenantRuntimeEntry;
  mutated: boolean;
}

const tenantContext = new AsyncLocalStorage<TenantRequestContext>();
const tenantRuntimeCache = new Map<string, TenantRuntimeEntry>();

let cached: StoreData | null = null;

export function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export function getTenantRuntime(tenantId: string): TenantRuntimeEntry | undefined {
  return tenantRuntimeCache.get(tenantId);
}

export function hydrateTenantStore(opts: {
  tenantId: string;
  uid: string;
  email: string;
  displayName: string;
  role: AppRole;
  version: number;
  shards: Partial<Record<ShardName, Record<string, any>>>;
  isSuperAdmin?: boolean;
}): TenantRuntimeEntry {
  const existing = tenantRuntimeCache.get(opts.tenantId);
  const store = mergeShardsToStore(opts.shards);

  // Ensure the authenticated cloud user is present in the workshop's users list with their authoritative Firestore role
  const normalizedEmail = opts.email.trim().toLowerCase();
  const effectiveRole: AppRole = opts.isSuperAdmin ? 'manager' : opts.role;
  let userRec = store.users.find((u) => u.email.toLowerCase() === normalizedEmail);
  if (!userRec) {
    userRec = {
      name: normalizedEmail,
      email: normalizedEmail,
      full_name: opts.displayName || normalizedEmail.split('@')[0],
      role: effectiveRole,
      enabled: 1,
      password: '',
      ui_scale: 1,
    };
    store.users.unshift(userRec);
  } else {
    userRec.role = effectiveRole;
    userRec.enabled = 1;
    if (opts.displayName && !userRec.full_name) userRec.full_name = opts.displayName;
  }

  const authorizedUids = existing ? existing.authorizedUids : new Set<string>();
  authorizedUids.add(opts.uid);

  const entry: TenantRuntimeEntry = {
    tenantId: opts.tenantId,
    store,
    version: Math.max(1, Number(opts.version) || 1),
    shardHashes: computeShardHashes(store),
    filesData: existing ? existing.filesData : new Map(),
    hydratedAt: Date.now(),
    authorizedUids,
  };
  tenantRuntimeCache.set(opts.tenantId, entry);
  return entry;
}

export function runWithTenantContext<T>(
  tenantId: string,
  fn: () => T
): { result: T; mutated: boolean; version: number; changedShards: Partial<Record<ShardName, Record<string, any>>> } {
  const entry = tenantRuntimeCache.get(tenantId);
  if (!entry) {
    throw new AtelierError('الجلسة السحابية تحتاج إلى إعادة مزامنة', 409);
  }
  const ctx: TenantRequestContext = { tenantId, entry, mutated: false };
  const result = tenantContext.run(ctx, fn);
  if (!ctx.mutated) {
    return { result, mutated: false, version: entry.version, changedShards: {} };
  }
  const { changed, nextHashes } = diffChangedShards(entry.store, entry.shardHashes);
  const changedKeys = Object.keys(changed);
  if (changedKeys.length > 0) {
    entry.version += 1;
    entry.shardHashes = nextHashes;
  }
  return {
    result,
    mutated: changedKeys.length > 0,
    version: entry.version,
    changedShards: changed,
  };
}

export function getActiveTenantId(): string | null {
  return tenantContext.getStore()?.tenantId || null;
}

export function getStore(): StoreData {
  const active = tenantContext.getStore();
  if (active) return active.entry.store;
  if (cached) return cached;
  ensureDirs();
  if (fs.existsSync(STORE_PATH)) {
    try {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      cached = JSON.parse(raw) as StoreData;
      return cached;
    } catch {
      // fall through to seed
    }
  }
  cached = createSeedData();
  saveStore();
  return cached;
}

export function saveStore() {
  const active = tenantContext.getStore();
  if (active) {
    active.mutated = true;
    return;
  }
  if (!cached) return;
  ensureDirs();
  fs.writeFileSync(STORE_PATH, JSON.stringify(cached, null, 2), 'utf-8');
}

export function resetStore(): StoreData {
  const active = tenantContext.getStore();
  if (active) {
    active.entry.store = createSeedData();
    active.mutated = true;
    return active.entry.store;
  }
  cached = createSeedData();
  saveStore();
  return cached;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowDateTime(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function addDays(isoStr: string, n: number): string {
  const d = new Date(isoStr.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const da = new Date(a.slice(0, 10) + 'T00:00:00Z').getTime();
  const db = new Date(b.slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((db - da) / 86400000);
}

export function nextId(prefix: string): string {
  const s = getStore();
  const n = (s.seq[prefix] || 0) + 1;
  s.seq[prefix] = n;
  const yr = new Date().getFullYear();
  if (['SO', 'SI', 'DN', 'PE', 'PI', 'PO', 'JE', 'STE', 'QTN'].includes(prefix)) {
    return `${prefix}-${yr}-${String(n).padStart(4, '0')}`;
  }
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

export function parseJsonArg<T = any>(val: any, fallback: T): T {
  if (val === undefined || val === null || val === '') return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

export function num(val: any, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export function round2(val: number): number {
  const r = Math.round((Number(val) || 0) * 100) / 100;
  return r === 0 ? 0 : r;
}

export function getUserByEmail(email?: string | null): UserAccount {
  const s = getStore();
  if (email) {
    const found = s.users.find((u) => u.email.toLowerCase() === email.toLowerCase() && u.enabled);
    if (found) return found;
  }
  return s.users.find((u) => u.role === 'manager' && u.enabled) || s.users[0];
}

export function isWorkerRole(role: AppRole): boolean {
  return role === 'designer' || role === 'production';
}

export function getPermissions(role: AppRole) {
  const worker = isWorkerRole(role);
  const manager = role === 'manager';
  const sales = role === 'sales';
  const accountant = role === 'accountant';
  return {
    order: (manager || sales) && !worker,
    customer: (manager || sales || accountant) && !worker,
    prices: manager,
    payment: (manager || sales || accountant) && !worker,
    box: sales && !worker,
    deliver: manager || sales,
    expense: manager || accountant,
    finance: manager || accountant,
    cost: manager || accountant,
    stock: role !== 'designer',
  };
}

export function getMemberName(userEmail: string): string | null {
  const s = getStore();
  const m = s.team.find((x) => x.user === userEmail);
  return m ? m.name : null;
}

export function getFullName(email: string): string {
  const s = getStore();
  const u = s.users.find((x) => x.email === email);
  return u ? u.full_name : email;
}

export function computeFundBalance(account: string): number {
  const s = getStore();
  let bal = 0;
  for (const op of s.openings) {
    if (!op.reversed && op.kind === 'fund' && op.target === account) bal += op.amount;
  }
  for (const p of s.payments) {
    if (p.account !== account || p.bounced) continue;
    // Uncleared cheques sit in clearing (شيكات قيد التحصيل) and are NEVER counted as available bank balance
    if (p.mode_of_payment === 'Cheque' && !p.clearance_date) continue;
    if (p.payment_type === 'Receive') bal += p.amount;
    else bal -= p.amount;
  }
  for (const e of s.expenses) {
    if (e.paid_from === account) bal -= e.amount;
  }
  for (const t of s.transfers) {
    if (t.from_account === account) bal -= t.amount;
    if (t.to_account === account) bal += t.amount;
  }
  for (const om of s.owner_moves) {
    if (om.account !== account) continue;
    if (om.kind === 'in') bal += om.amount;
    else bal -= om.amount;
  }
  for (const h of s.handovers) {
    if (h.status !== 'confirmed') continue;
    if (h.account === account) bal -= h.recorded;
    if (account === 'CASH-MAIN') bal += h.counted;
  }
  for (const cl of s.closings) {
    if (cl.account === account && Math.abs(cl.diff || 0) > 0.005) {
      bal += cl.diff;
    }
  }
  return round2(bal);
}

export function ensureFunds(account: string, amount: number): void {
  const s = getStore();
  const avail = computeFundBalance(account);
  if (amount > avail + 0.005) {
    const label = s.funds.find((f) => f.name === account)?.account_name || account;
    throw new AtelierError(
      `الرصيد المتاح في «${label}» (${avail} دج) لا يكفي لصرف ${round2(amount)} دج (الشيكات غير المحصّلة لا تُحتسب ضمن الرصيد المتاح).`
    );
  }
}

export function computeSupplierBalance(supplierName: string): {
  owe: number;
  invoices_owe: number;
  opening_owe: number;
} {
  const s = getStore();
  const sup = s.suppliers.find((x) => x.name === supplierName);
  const invoicesOwe = round2(
    s.supplier_invoices
      .filter((i) => i.supplier === supplierName && i.docstatus === 1 && i.outstanding_amount > 0.005)
      .reduce((a, i) => a + i.outstanding_amount, 0)
  );
  const openingOwe = round2(
    (sup?.opening_balance || 0) +
      s.openings
        .filter((op) => !op.reversed && op.kind === 'Supplier' && op.target === supplierName)
        .reduce((a, b) => a + b.amount, 0)
  );
  const unallocatedPaid = round2(
    s.payments
      .filter((p) => !p.bounced && p.party_type === 'Supplier' && p.party === supplierName && p.payment_type === 'Pay' && !p.invoice)
      .reduce((a, p) => a + p.amount, 0)
  );
  const owe = round2(Math.max(0, invoicesOwe + openingOwe - unallocatedPaid));
  return { owe, invoices_owe: invoicesOwe, opening_owe: Math.max(0, round2(openingOwe - unallocatedPaid)) };
}

export function computeOrderPaid(orderName: string): number {
  const s = getStore();
  let total = 0;
  for (const p of s.payments) {
    if (p.party_type !== 'Customer' || p.bounced) continue;
    if (p.sales_order === orderName) {
      if (p.payment_type === 'Receive') total += p.amount;
      else total -= p.amount;
    } else if (Array.isArray(p.allocations) && p.allocations.length) {
      for (const al of p.allocations) {
        if (al.order === orderName) {
          if (p.payment_type === 'Receive') total += al.amount;
          else total -= al.amount;
        }
      }
    }
  }
  return round2(Math.max(0, total));
}

export function getOrderTvaMultiplier(customerName: string): number {
  const s = getStore();
  const cust = s.customers.find((c) => c.name === customerName);
  const tvaOn = Boolean(s.docs.tva && !cust?.tva_exempt);
  return tvaOn ? 1 + (s.docs.tva_rate || 19) / 100 : 1;
}

export function ensureOrderInvoices(order: OrderRecord): OrderInvoiceRecord[] {
  if (Array.isArray(order.invoices) && order.invoices.length) {
    return order.invoices;
  }
  // Backward-compatibility for legacy fully-billed orders without an explicit invoices array
  if (order.per_billed >= 100 && order.grand_total > 0 && order.docstatus === 1) {
    const s = getStore();
    const postDate = order.invoiced_date || order.transaction_date;
    const dueDate = addDays(postDate, s.docs.payment_days || 15);
    const paid = round2(Math.min(order.grand_total, computeOrderPaid(order.name)));
    order.invoices = [
      {
        name: order.invoice_name || nextId('SI'),
        posting_date: postDate,
        due_date: dueDate,
        net_total: order.net_total,
        grand_total: order.grand_total,
        paid_amount: paid,
        outstanding_amount: round2(Math.max(0, order.grand_total - paid)),
      },
    ];
    return order.invoices;
  }
  return order.invoices || [];
}

export function computeOrderBillingBreakdown(order: OrderRecord): {
  billedTotal: number;
  billedOutstanding: number;
  unbilledTotal: number;
  unbilledDue: number;
  unallocatedAdvance: number;
} {
  if (order.docstatus === 2 || order.price_pending) {
    return { billedTotal: 0, billedOutstanding: 0, unbilledTotal: 0, unbilledDue: 0, unallocatedAdvance: 0 };
  }
  const invs = ensureOrderInvoices(order);
  const regularInvs = invs.filter((i) => !i.is_return);
  const returnInvs = invs.filter((i) => i.is_return);

  const billedGross = round2(
    regularInvs.reduce((a, i) => a + i.grand_total, 0) -
      returnInvs.reduce((a, i) => a + Math.abs(i.grand_total), 0)
  );
  const billedPaid = round2(regularInvs.reduce((a, i) => a + i.paid_amount, 0));
  const billedOutstanding = round2(
    regularInvs.reduce((a, i) => a + Math.max(0, i.outstanding_amount), 0)
  );

  // Unbilled portion is strictly the portion of grand_total not yet billed — NEVER double-counts invoiced amounts
  const unbilledTotal = round2(
    Math.max(0, regularInvs.length ? order.grand_total - billedGross : order.grand_total * (1 - order.per_billed / 100))
  );
  // Any order payment not yet applied to existing invoices covers the unbilled portion
  const unallocatedAdvance = round2(Math.max(0, order.paid - billedPaid));
  const unbilledDue = round2(Math.max(0, unbilledTotal - unallocatedAdvance));

  return {
    billedTotal: Math.max(0, billedGross),
    billedOutstanding,
    unbilledTotal,
    unbilledDue,
    unallocatedAdvance,
  };
}

export function syncOrderTotals(order: OrderRecord) {
  const hasPending = order.lines.some((l) => l.price_pending || l.rate === null || l.rate === undefined);
  order.price_pending = hasPending ? 1 : 0;
  let net = 0;
  for (const l of order.lines) {
    if (l.rate !== null && l.rate !== undefined && !l.price_pending) {
      l.amount = round2(num(l.qty) * num(l.rate));
      net += l.amount;
    } else {
      l.amount = null;
    }
  }
  const mult = getOrderTvaMultiplier(order.customer);
  const grand = round2(net * mult);
  order.net_total = round2(net);
  order.grand_total = hasPending ? 0 : grand;
  order.paid = computeOrderPaid(order.name);
}

export function computeCustomerBalance(customerName: string): {
  balance: number;
  invoiced: number;
  received: number;
  outstanding: number;
  unbilled: number;
  invoices: number;
} {
  const s = getStore();
  const cust = s.customers.find((c) => c.name === customerName);
  const opening = cust?.opening_balance || 0;
  const openExtra = s.openings
    .filter((o) => !o.reversed && o.kind === 'Customer' && o.target === customerName)
    .reduce((a, b) => a + b.amount, 0);

  let invoiced = 0;
  let invoicedOutstanding = 0;
  let unbilledDue = 0;
  let unbilledGross = 0;
  let received = 0;

  for (const o of s.orders) {
    if (o.customer !== customerName || o.docstatus === 2) continue;
    const br = computeOrderBillingBreakdown(o);
    invoiced = round2(invoiced + br.billedTotal);
    invoicedOutstanding = round2(invoicedOutstanding + br.billedOutstanding);
    unbilledDue = round2(unbilledDue + br.unbilledDue);
    unbilledGross = round2(unbilledGross + br.unbilledTotal);
  }
  for (const p of s.payments) {
    if (p.party_type === 'Customer' && p.party === customerName && !p.bounced) {
      if (p.payment_type === 'Receive') received += p.amount;
      else received -= p.amount;
    }
  }

  const ledgerBalance = round2(opening + openExtra + invoiced - received);
  const totalBalance = round2(ledgerBalance + unbilledGross);
  const invoicesDue = round2(Math.max(0, totalBalance - unbilledDue));
  return {
    balance: Math.max(0, totalBalance),
    invoiced: round2(invoiced),
    received: round2(received),
    outstanding: Math.max(0, round2(opening + openExtra + invoiced - received)),
    unbilled: round2(unbilledDue),
    invoices: Math.max(0, invoicesDue, invoicedOutstanding > 0 ? Math.min(Math.max(0, totalBalance), round2(invoicedOutstanding + Math.max(0, opening + openExtra))) : invoicesDue),
  };
}

export function getPeriodBounds(period = 'month', start?: string, end?: string): [string, string, string, string] {
  const now = new Date();
  let a: Date;
  let b: Date;
  if (period === 'custom' && start && end) {
    a = new Date(start + 'T00:00:00Z');
    b = new Date(end + 'T00:00:00Z');
  } else if (period === 'week') {
    b = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    a = new Date(b);
    a.setUTCDate(a.getUTCDate() - 6);
  } else if (period === 'quarter') {
    const qm = Math.floor(now.getUTCMonth() / 3) * 3;
    a = new Date(Date.UTC(now.getUTCFullYear(), qm, 1));
    b = new Date(Date.UTC(now.getUTCFullYear(), qm + 3, 0));
  } else if (period === 'year') {
    a = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    b = new Date(Date.UTC(now.getUTCFullYear(), 11, 31));
  } else {
    a = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    b = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  }
  const spanDays = Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1);
  const pb = new Date(a.getTime() - 86400000);
  const pa = new Date(pb.getTime() - (spanDays - 1) * 86400000);
  return [
    a.toISOString().slice(0, 10),
    b.toISOString().slice(0, 10),
    pa.toISOString().slice(0, 10),
    pb.toISOString().slice(0, 10),
  ];
}

export function addCardLog(orderName: string, content: string, owner: string, type: 'Info' | 'Comment' = 'Info') {
  const s = getStore();
  s.comments.unshift({
    name: nextId('CMT'),
    reference_doctype: 'Sales Order',
    reference_name: orderName,
    comment_type: type,
    content,
    owner,
    creation: nowDateTime(),
  });
}

export function notifyMember(memberName: string, orderName: string, text: string) {
  const s = getStore();
  const m = s.team.find((x) => x.name === memberName);
  if (!m?.user) return;
  s.notifications.unshift({
    id: `NT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    user: m.user,
    order: orderName,
    text,
    at: nowDateTime(),
    read: 0,
  });
}
