export type AppRole = 'manager' | 'sales' | 'designer' | 'production' | 'accountant';

export interface BoardColumn {
  id: string;
  name: string;
  color: string;
  deliver?: number;
}

export interface BoardTag {
  id: string;
  name: string;
  color: string;
}

export interface BoardConfig {
  columns: BoardColumn[];
  statuses: BoardTag[];
  labels: BoardTag[];
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface OrderLine {
  idx: number;
  item_code: string;
  item_name: string;
  item_group?: string;
  description: string;
  qty: number;
  uom: string;
  atelier_unit?: string;
  size?: string;
  width?: number | null;
  height?: number | null;
  length?: number | null;
  pieces?: number | null;
  rate: number | null;
  amount: number | null;
  price_pending: number;
  delivered_qty: number;
  material?: string;
  per_sheet?: number | null;
}

export interface CostEstimateLine {
  cost_type: string;
  description: string;
  item?: string | null;
  qty: number;
  rate: number | null;
  amount: number;
  source?: string;
}

export interface OrderInvoiceRecord {
  name: string;
  posting_date: string;
  due_date: string;
  net_total: number;
  grand_total: number;
  paid_amount: number;
  outstanding_amount: number;
  is_return?: number;
  return_against?: string | null;
  reason?: string;
}

export interface OrderRecord {
  name: string;
  title: string;
  customer: string;
  customer_name: string;
  transaction_date: string;
  delivery_date: string | null;
  due_time: string | null;
  column: string;
  status_id: string | null;
  statuses?: string[];
  labels: string[];
  tags: string[];
  members: string[];
  description: string;
  checklist: ChecklistItem[];
  cover: string | null;
  cover_color: string | null;
  final: string | null;
  pos: number;
  lines: OrderLine[];
  grand_total: number;
  net_total: number;
  paid: number;
  returned_net?: number;
  returned_amount?: number;
  invoices?: OrderInvoiceRecord[];
  price_pending: number;
  docstatus: number; // 0 draft, 1 submitted, 2 cancelled
  status: string;
  per_delivered: number;
  per_billed: number;
  delivered_date: string | null;
  invoiced_date: string | null;
  invoice_name: string | null;
  delivery_note: string | null;
  archived: number; // 0 active, 1 archived, 2 cancelled
  materials_done: number;
  outsourced: number;
  outsource_supplier?: string | null;
  outsource_amount?: number;
  cost_lines: CostEstimateLine[];
  creation: string;
  modified: string;
  owner: string;
}

export interface CustomerContact {
  name: string;
  role?: string;
  phone?: string;
  email?: string;
}

export interface CustomerRecord {
  name: string;
  customer_name: string;
  customer_type: 'Individual' | 'Company';
  relation: string;
  contact_person: string;
  mobile_no: string;
  email_id: string;
  address: string;
  city: string;
  notes: string;
  note: string;
  vip: number;
  disabled: number;
  tax_id: string; // NIF
  rc: string;
  nis: string;
  ai: string;
  credit_limit: number;
  tva_exempt: number;
  tags: string[];
  contacts: CustomerContact[];
  opening_balance: number;
  creation: string;
}

export interface SupplierRecord {
  name: string;
  supplier_name: string;
  supplies: string;
  phone: string;
  email: string;
  address: string;
  tax_id: string;
  rc: string;
  note: string;
  disabled: number;
  opening_balance: number;
  creation: string;
}

export interface SupplierInvoice {
  name: string;
  supplier: string;
  supplier_name: string;
  posting_date: string;
  due_date: string;
  net_total?: number;
  tva_rate?: number;
  tva_amount?: number;
  grand_total: number;
  outstanding_amount: number;
  bill_no: string;
  order_name: string | null;
  what: string;
  account: string;
  items: { item_code?: string; item_name: string; description: string; qty: number; rate: number; amount: number; uom?: string; conversion_factor?: number; is_stock?: number }[];
  docstatus: number;
}

export interface PurchaseOrderRecord {
  name: string;
  supplier: string;
  supplier_name: string;
  transaction_date: string;
  schedule_date: string;
  grand_total: number;
  per_billed: number;
  per_received: number;
  status: string;
  order_name: string | null;
  what: string;
}

export interface PaymentRecord {
  name: string;
  posting_date: string;
  creation: string;
  payment_type: 'Receive' | 'Pay';
  party_type: 'Customer' | 'Supplier';
  party: string;
  party_name: string;
  amount: number;
  mode_of_payment: string;
  account: string;
  sales_order?: string | null;
  invoice?: string | null;
  reference_no?: string | null;
  reference_date?: string | null;
  clearance_date?: string | null;
  bounced?: number;
  bounce_reason?: string;
  allocations?: { invoice?: string | null; order?: string | null; amount: number }[];
  unallocated_amount?: number;
  owner: string;
  note?: string;
}

export interface ExpenseRecord {
  name: string;
  posting_date: string;
  creation: string;
  account: string;
  account_name: string;
  amount: number;
  mode_of_payment: string;
  paid_from: string;
  description: string;
  sales_order?: string | null;
  owner: string;
}

export interface TransferRecord {
  name: string;
  posting_date: string;
  creation: string;
  from_account: string;
  to_account: string;
  amount: number;
  note: string;
  owner: string;
}

export interface OwnerMoveRecord {
  name: string;
  posting_date: string;
  creation: string;
  kind: 'in' | 'out';
  account: string;
  amount: number;
  note: string;
  owner: string;
}

export interface CashClosing {
  id: string;
  account: string;
  label: string;
  at: string;
  date: string;
  recorded: number;
  counted: number;
  diff: number;
  note: string;
  by: string;
}

export interface HandoverRecord {
  id: string;
  user: string;
  name: string;
  account: string;
  at: string;
  recorded: number;
  counted: number;
  diff: number;
  reason: string;
  count: number;
  status: 'pending' | 'confirmed' | 'rejected';
  resolved_at?: string;
}

export interface OpeningEntry {
  name: string;
  kind: 'fund' | 'Customer' | 'Supplier';
  target: string;
  target_label: string;
  amount: number;
  posting_date: string;
  remark: string;
  reversed?: number;
}

export interface FundAccount {
  name: string;
  account_name: string;
  account_type: 'Cash' | 'Bank';
  user?: string | null;
}

export interface PaymentMode {
  value: string;
  label: string;
  account: string;
}

export interface ExpenseAccount {
  name: string;
  account_name: string;
  account_number: string;
}

export interface RecipeRow {
  item_code: string;
  qty: number;
}

export interface ServiceItem {
  item_code: string;
  item_name: string;
  item_group: string;
  stock_uom: string;
  atelier_category: string;
  is_stock_item: number;
  standard_rate: number;
  price_individual: number | null;
  price_company: number | null;
  recipe: RecipeRow[];
  disabled?: number;
}

export interface MaterialPackCfg {
  section: string;
  way: 'count' | 'roll' | 'bottle';
  kind: string;
  size: string;
  gsm: number;
  width: number;
  length: number;
  pack: string;
  pack_qty: number;
  waste: number;
  closed: number;
  open_since: string | null;
  open_cost: number;
}

export interface MaterialItem {
  item_code: string;
  item_name: string;
  group: string;
  uom: string;
  safety_stock: number;
  qty: number;
  reserved: number;
  valuation_rate: number;
  family: string;
  cfg: MaterialPackCfg;
  disabled?: number;
}

export interface StockMove {
  id: string;
  posting_date: string;
  creation: string;
  item_code: string;
  item_name: string;
  warehouse: string;
  actual_qty: number;
  voucher_type: 'Stock Entry' | 'Purchase Invoice' | 'Stock Reconciliation';
  voucher_no: string;
  stock_value_difference: number;
  order?: string | null;
  order_title?: string | null;
  uom?: string;
  conversion_factor?: number;
  buy_rate?: number;
  supplier_name?: string;
  note?: string;
  owner: string;
}

export interface MaterialCycle {
  id: string;
  item: string;
  opened_on: string;
  closed_on: string;
  size: number;
  cost: number;
  recorded: number;
  gap: number;
  coverage: number;
  orders: { order: string; title?: string; qty: number }[];
}

export interface SavedCalc {
  id: string;
  title: string;
  item_code: string | null;
  qty: number;
  width: number;
  height: number;
  waste_percent: number;
  lines: CostEstimateLine[];
  at: string;
  by: string;
}

export interface FileRecord {
  name: string;
  file_name: string;
  file_url: string;
  file_size: number;
  is_private: number;
  attached_to_doctype: string;
  attached_to_name: string;
  atelier_kind: string;
  creation: string;
  owner: string;
}

export interface CommentRecord {
  name: string;
  reference_doctype: string;
  reference_name: string;
  comment_type: 'Comment' | 'Info';
  content: string;
  owner: string;
  creation: string;
}

export interface NotificationRecord {
  id: string;
  user: string;
  order: string;
  text: string;
  at: string;
  read: number;
}

export interface TeamMember {
  name: string;
  role: string;
  user?: string | null;
}

export interface UserAccount {
  name: string; // email
  email: string;
  full_name: string;
  role: AppRole;
  enabled: number;
  password: string;
  ui_scale: number;
}

export interface CardTemplate {
  id: string;
  title: string;
  subject: string;
  description: string;
  checklist: ChecklistItem[];
  labels: string[];
  lines: Partial<OrderLine>[];
}

export interface ChecklistTemplate {
  title: string;
  items: string[];
}

export interface ShareRecord {
  token: string;
  items: string[];
  days: number;
  prices: number;
  created_at: string;
  expires_at: string;
}

export interface StoreData {
  seq: Record<string, number>;
  profile: {
    name_ar: string;
    name_fr: string;
    address: string;
    city: string;
    phone: string;
    phone2: string;
    email: string;
    rc: string;
    nif: string;
    nis: string;
    ai: string;
    rib: string;
    logo: string;
  };
  docs: {
    tva: number;
    tva_rate: number;
    footer: string;
    payment_days: number;
    quote_days: number;
    show_description: number;
  };
  alerts: {
    late_days: number;
    away_days: number;
    low_stock: number;
    unpaid_days: number;
  };
  email: {
    configured: number;
    email_id: string;
    smtp_server: string;
    smtp_port: number;
    security: 'tls' | 'ssl' | 'none';
    login_id: string;
    has_password: number;
  };
  folders: {
    enabled: number;
    root: string;
    pattern: string;
    last_sync: string | null;
  };
  calendar: {
    day_limit: number;
    off_days: number[];
  };
  board: BoardConfig;
  units: { name: string; calc: 'count' | 'area' | 'length'; scale?: 'm' | 'cm' | null; whole: number; group?: string }[];
  lists: Record<string, any[]>;
  customer_tags: string[];
  margins: { individual: number; company: number; reseller: number };
  target_margin: number;
  team: TeamMember[];
  users: UserAccount[];
  funds: FundAccount[];
  modes: PaymentMode[];
  expense_accounts: ExpenseAccount[];
  services: ServiceItem[];
  materials: MaterialItem[];
  stock_moves: StockMove[];
  material_cycles: MaterialCycle[];
  customers: CustomerRecord[];
  suppliers: SupplierRecord[];
  orders: OrderRecord[];
  supplier_invoices: SupplierInvoice[];
  purchase_orders: PurchaseOrderRecord[];
  payments: PaymentRecord[];
  expenses: ExpenseRecord[];
  transfers: TransferRecord[];
  owner_moves: OwnerMoveRecord[];
  closings: CashClosing[];
  handovers: HandoverRecord[];
  openings: OpeningEntry[];
  files: FileRecord[];
  comments: CommentRecord[];
  notifications: NotificationRecord[];
  calcs: SavedCalc[];
  card_templates: CardTemplate[];
  checklist_templates: ChecklistTemplate[];
  backups: { name: string; date: string; size: number }[];
  shares: ShareRecord[];
}
