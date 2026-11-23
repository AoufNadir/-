import { createSeedData } from './seed.ts';
import { AppRole, StoreData } from './types.ts';

export type ShardName = 'meta' | 'people' | 'catalog' | 'orders' | 'finance' | 'inventory';

export const SHARD_NAMES: ShardName[] = ['meta', 'people', 'catalog', 'orders', 'finance', 'inventory'];

const SHARD_KEYS: Record<ShardName, (keyof StoreData)[]> = {
  meta: [
    'seq',
    'profile',
    'docs',
    'alerts',
    'email',
    'folders',
    'calendar',
    'board',
    'units',
    'lists',
    'customer_tags',
    'margins',
    'target_margin',
    'backups',
    'shares',
  ],
  people: ['team', 'users', 'customers', 'suppliers'],
  catalog: [
    'funds',
    'modes',
    'expense_accounts',
    'services',
    'materials',
    'calcs',
    'card_templates',
    'checklist_templates',
  ],
  orders: ['orders', 'comments', 'notifications'],
  finance: [
    'supplier_invoices',
    'purchase_orders',
    'payments',
    'expenses',
    'transfers',
    'owner_moves',
    'closings',
    'handovers',
    'openings',
  ],
  inventory: ['stock_moves', 'material_cycles', 'files'],
};

/**
 * Strip `undefined` values recursively so Firestore native Maps/Lists never reject a payload.
 */
export function sanitizeForFirestore<T>(val: T): T {
  if (val === undefined) return null as unknown as T;
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    return val.map((item) => (item === undefined ? null : sanitizeForFirestore(item))) as unknown as T;
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(val as Record<string, any>)) {
    if (v !== undefined) {
      out[k] = sanitizeForFirestore(v);
    }
  }
  return out as T;
}

export function splitStoreToShards(store: StoreData): Record<ShardName, Record<string, any>> {
  const result = {} as Record<ShardName, Record<string, any>>;
  for (const shard of SHARD_NAMES) {
    const obj: Record<string, any> = {};
    for (const key of SHARD_KEYS[shard]) {
      obj[key] = sanitizeForFirestore(store[key]);
    }
    result[shard] = obj;
  }
  return result;
}

export function mergeShardsToStore(
  shards: Partial<Record<ShardName, Record<string, any>>>,
  fallbackBase?: StoreData
): StoreData {
  const base = fallbackBase ? structuredClone(fallbackBase) : createBlankWorkshopData({});
  for (const shard of SHARD_NAMES) {
    const data = shards[shard];
    if (!data || typeof data !== 'object') continue;
    for (const key of SHARD_KEYS[shard]) {
      if (data[key] !== undefined && data[key] !== null) {
        (base as any)[key] = structuredClone(data[key]);
      }
    }
  }
  return base;
}

export function computeShardHashes(store: StoreData): Record<ShardName, string> {
  const shards = splitStoreToShards(store);
  const hashes = {} as Record<ShardName, string>;
  for (const shard of SHARD_NAMES) {
    hashes[shard] = JSON.stringify(shards[shard]);
  }
  return hashes;
}

export function diffChangedShards(
  store: StoreData,
  prevHashes: Record<ShardName, string>
): { changed: Partial<Record<ShardName, Record<string, any>>>; nextHashes: Record<ShardName, string> } {
  const shards = splitStoreToShards(store);
  const changed: Partial<Record<ShardName, Record<string, any>>> = {};
  const nextHashes = {} as Record<ShardName, string>;
  for (const shard of SHARD_NAMES) {
    const serialized = JSON.stringify(shards[shard]);
    nextHashes[shard] = serialized;
    if (serialized !== prevHashes[shard]) {
      changed[shard] = shards[shard];
    }
  }
  return { changed, nextHashes };
}

export interface WorkshopSeedOptions {
  name?: string;
  city?: string;
  phone?: string;
  ownerEmail?: string;
  ownerName?: string;
  ownerRole?: AppRole;
}

/**
 * Clean commercial-ready blank workshop store (no fake customers, orders, or transactions).
 */
export function createBlankWorkshopData(opts: WorkshopSeedOptions): StoreData {
  const template = createSeedData();
  const ownerEmail = String(opts.ownerEmail || 'manager@atelier.dz').trim().toLowerCase();
  const ownerName = String(opts.ownerName || opts.name || 'مدير المطبعة').trim();
  const workshopName = String(opts.name || 'مطبعتي').trim();

  return {
    seq: {
      SO: 0,
      SI: 0,
      DN: 0,
      PE: 0,
      PI: 0,
      PO: 0,
      JE: 0,
      STE: 0,
      QTN: 0,
      CALC: 0,
      FILE: 0,
      CMT: 0,
      TPL: 0,
    },
    profile: {
      name_ar: workshopName,
      name_fr: '',
      address: '',
      city: String(opts.city || '').trim(),
      phone: String(opts.phone || '').trim(),
      phone2: '',
      email: ownerEmail,
      rc: '',
      nif: '',
      nis: '',
      ai: '',
      rib: '',
      logo: '',
    },
    docs: {
      tva: 0,
      tva_rate: 19,
      footer: 'شكرًا لثقتكم — يسعدنا التعامل معكم دائمًا.',
      payment_days: 15,
      quote_days: 15,
      show_description: 1,
    },
    alerts: { ...template.alerts },
    email: {
      configured: 0,
      email_id: '',
      smtp_server: '',
      smtp_port: 587,
      security: 'tls',
      login_id: '',
      has_password: 0,
    },
    folders: {
      enabled: 0,
      root: '',
      pattern: '{customer}/{order}',
      last_sync: null,
    },
    calendar: { ...template.calendar },
    board: structuredClone(template.board),
    units: structuredClone(template.units),
    lists: structuredClone(template.lists),
    customer_tags: [...template.customer_tags],
    margins: { ...template.margins },
    target_margin: template.target_margin,
    team: [{ name: ownerName, role: 'مدير', user: ownerEmail }],
    users: [
      {
        name: ownerEmail,
        email: ownerEmail,
        full_name: ownerName,
        role: opts.ownerRole || 'manager',
        enabled: 1,
        password: '',
        ui_scale: 1,
      },
    ],
    funds: [
      { name: 'CASH-MAIN', account_name: 'الصندوق الرئيسي', account_type: 'Cash', user: null },
      { name: 'BANK-MAIN', account_name: 'الحساب البنكي / CCP', account_type: 'Bank', user: null },
    ],
    modes: [
      { value: 'Cash', label: 'نقدًا', account: 'CASH-MAIN' },
      { value: 'Bank', label: 'تحويل بنكي', account: 'BANK-MAIN' },
      { value: 'CCP', label: 'بريدي موب / CCP', account: 'BANK-MAIN' },
      { value: 'Cheque', label: 'شيك', account: 'BANK-MAIN' },
    ],
    expense_accounts: structuredClone(template.expense_accounts),
    services: [
      {
        item_code: 'SRV-GENERAL',
        item_name: 'عمل طباعة عام',
        item_group: 'طباعة رقمية',
        stock_uom: 'قطعة',
        atelier_category: 'طباعة رقمية',
        is_stock_item: 0,
        standard_rate: 0,
        price_individual: null,
        price_company: null,
        recipe: [],
      },
    ],
    materials: [],
    stock_moves: [],
    material_cycles: [],
    customers: [],
    suppliers: [],
    orders: [],
    supplier_invoices: [],
    purchase_orders: [],
    payments: [],
    expenses: [],
    transfers: [],
    owner_moves: [],
    closings: [],
    handovers: [],
    openings: [],
    files: [],
    comments: [],
    notifications: [],
    calcs: [],
    card_templates: [],
    checklist_templates: [],
    backups: [],
    shares: [],
  };
}

/**
 * Demo-seeded workshop personalized with the workshop name and owner Google email.
 */
export function createDemoWorkshopData(opts: WorkshopSeedOptions): StoreData {
  const s = createSeedData();
  const ownerEmail = String(opts.ownerEmail || 'nadiraouf16@gmail.com').trim().toLowerCase();
  const ownerName = String(opts.ownerName || 'مدير المطبعة').trim();
  if (opts.name) s.profile.name_ar = String(opts.name).trim();
  if (opts.city) s.profile.city = String(opts.city).trim();
  if (opts.phone) s.profile.phone = String(opts.phone).trim();
  s.profile.email = ownerEmail;

  // Bind the primary manager account to the actual owner Google email
  const existingOwner = s.users.find((u) => u.email.toLowerCase() === ownerEmail);
  if (existingOwner) {
    existingOwner.role = 'manager';
    existingOwner.enabled = 1;
    existingOwner.full_name = ownerName || existingOwner.full_name;
  } else {
    s.users.unshift({
      name: ownerEmail,
      email: ownerEmail,
      full_name: ownerName,
      role: 'manager',
      enabled: 1,
      password: '',
      ui_scale: 1,
    });
  }
  if (!s.team.some((m) => (m.user || '').toLowerCase() === ownerEmail)) {
    s.team.unshift({ name: ownerName, role: 'مدير', user: ownerEmail });
  }
  return s;
}
