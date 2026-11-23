import {
  AtelierError,
  addDays,
  getMemberName,
  getPermissions,
  getStore,
  isWorkerRole,
  nextId,
  nowDateTime,
  num,
  parseJsonArg,
  saveStore,
  todayISO,
} from '../store.ts';
import { UserAccount } from '../types.ts';

const STAGES = ['جديد', 'تصميم', 'طباعة', 'تشطيب', 'جاهز', 'مُسلَّم'];
const STEP_KINDS = ['تصميم', 'موافقة العميل', 'طباعة رقمية', 'طباعة أوفست', 'طباعة كبيرة', 'قص', 'تشطيب', 'تركيب'];

export const coreHandlers: Record<string, (args: Record<string, any>, user: UserAccount) => any> = {
  boot(_args, user) {
    const s = getStore();
    const worker = isWorkerRole(user.role);
    const items = s.services
      .filter((i) => !i.disabled)
      .map((i) => {
        if (worker) {
          return {
            item_code: i.item_code,
            item_name: i.item_name,
            stock_uom: i.stock_uom,
            is_stock_item: i.is_stock_item,
            atelier_category: i.atelier_category,
          };
        }
        return {
          item_code: i.item_code,
          item_name: i.item_name,
          stock_uom: i.stock_uom,
          is_stock_item: i.is_stock_item,
          standard_rate: i.standard_rate,
          atelier_category: i.atelier_category,
          price_individual: i.price_individual,
          price_company: i.price_company,
        };
      });

    const tags = Array.from(
      new Set(s.orders.flatMap((o) => o.tags || []).filter(Boolean))
    ).sort();

    return {
      user: user.email,
      full_name: user.full_name,
      company: s.profile.name_ar || 'مطبعة رقمي',
      company_label: s.profile.name_ar || 'مطبعة رقمي',
      currency: 'DZD',
      is_demo: false,
      items,
      stages: STAGES,
      units: s.units,
      lists: s.lists,
      step_kinds: STEP_KINDS,
      step_modes: ['داخلي', 'عند مورد'],
      team: s.team.map((m) => m.name),
      team_members: s.team,
      me: getMemberName(user.email),
      suppliers: s.suppliers
        .filter((x) => !x.disabled)
        .map((x) => ({ name: x.name, supplier_name: x.supplier_name })),
      tags,
      modes: s.modes.map((m) => ({ value: m.value, label: m.label })),
      can: getPermissions(user.role),
      role: user.role,
      worker,
      ui_scale: user.ui_scale || 1,
      tva_rate: s.docs.tva ? s.docs.tva_rate || 19 : 0,
    };
  },

  search(args, user) {
    const s = getStore();
    const q = String(args.q || '').trim().toLowerCase();
    if (!q) return { orders: [], customers: [], items: [] };
    const worker = isWorkerRole(user.role);
    const me = getMemberName(user.email);

    const orders = s.orders
      .filter((o) => {
        if (o.docstatus === 2) return false;
        if (worker && (!me || !o.members.includes(me))) return false;
        return (
          o.name.toLowerCase().includes(q) ||
          o.title.toLowerCase().includes(q) ||
          o.customer_name.toLowerCase().includes(q)
        );
      })
      .slice(0, 10)
      .map((o) => ({
        name: o.name,
        title: o.title,
        customer_name: o.customer_name,
        delivery_date: o.delivery_date,
        grand_total: worker ? null : o.grand_total,
      }));

    const customers = worker
      ? []
      : s.customers
          .filter(
            (c) =>
              c.name !== 'CUS-CASH' &&
              (c.customer_name.toLowerCase().includes(q) ||
                c.mobile_no.toLowerCase().includes(q) ||
                c.city.toLowerCase().includes(q))
          )
          .slice(0, 8)
          .map((c) => ({
            name: c.name,
            customer_name: c.customer_name,
            mobile_no: c.mobile_no,
            customer_type: c.customer_type,
          }));

    const items = s.services
      .filter(
        (i) =>
          !i.disabled &&
          (i.item_name.toLowerCase().includes(q) || i.item_code.toLowerCase().includes(q))
      )
      .slice(0, 8)
      .map((i) => ({
        item_code: i.item_code,
        item_name: i.item_name,
        atelier_category: i.atelier_category,
      }));

    return { orders, customers, items };
  },

  notifications(_args, user) {
    const s = getStore();
    const rows = s.notifications.filter((n) => n.user === user.email || user.role === 'manager').slice(0, 40);
    return {
      rows,
      unread: rows.filter((r) => !r.read).length,
    };
  },

  mark_read(_args, user) {
    const s = getStore();
    for (const n of s.notifications) {
      if (n.user === user.email || user.role === 'manager') n.read = 1;
    }
    saveStore();
    return { ok: true };
  },

  set_ui_scale(args, user) {
    const s = getStore();
    const scale = num(args.scale, 1);
    const u = s.users.find((x) => x.email === user.email);
    if (u) {
      u.ui_scale = scale;
      saveStore();
    }
    return scale;
  },

  card_templates() {
    return getStore().card_templates;
  },

  save_card_template(args) {
    const s = getStore();
    const title = String(args.title || '').trim();
    if (!title) throw new AtelierError('اكتب اسم القالب');
    const source = s.orders.find((o) => o.name === args.name);
    if (!source) throw new AtelierError('الطلب غير موجود');
    const tpl = {
      id: nextId('TPL'),
      title,
      subject: source.title,
      description: source.description,
      checklist: source.checklist.map((c) => ({ text: c.text, done: false })),
      labels: [...source.labels],
      lines: source.lines.map((l) => ({
        item_code: l.item_code,
        item_name: l.item_name,
        description: l.description,
        qty: l.qty,
        uom: l.uom,
        size: l.size,
        rate: l.rate,
      })),
    };
    s.card_templates.unshift(tpl);
    saveStore();
    return tpl;
  },

  delete_card_template(args) {
    const s = getStore();
    s.card_templates = s.card_templates.filter((t) => t.id !== args.id);
    saveStore();
    return s.card_templates;
  },

  checklist_templates() {
    return getStore().checklist_templates;
  },

  save_checklist_template(args) {
    const s = getStore();
    const title = String(args.title || '').trim();
    const items = parseJsonArg<string[]>(args.items, []).filter(Boolean);
    if (!title || !items.length) throw new AtelierError('اكتب اسم القائمة وعناصرها');
    const idx = s.checklist_templates.findIndex((t) => t.title === title);
    if (idx >= 0) s.checklist_templates[idx] = { title, items };
    else s.checklist_templates.push({ title, items });
    saveStore();
    return s.checklist_templates;
  },

  delete_checklist_template(args) {
    const s = getStore();
    s.checklist_templates = s.checklist_templates.filter((t) => t.title !== args.title);
    saveStore();
    return s.checklist_templates;
  },

  create_share(args) {
    const s = getStore();
    const items = parseJsonArg<string[]>(args.items, []);
    const days = Math.max(1, num(args.days, 30));
    const token = Math.random().toString(36).slice(2, 12);
    const share = {
      token,
      items,
      days,
      prices: num(args.prices, 0),
      created_at: nowDateTime(),
      expires_at: addDays(todayISO(), days),
    };
    s.shares.unshift(share);
    saveStore();
    return { token, url: `/atelier/share/${token}`, expires_at: share.expires_at };
  },

  revoke_share(args) {
    const s = getStore();
    s.shares = s.shares.filter((x) => x.token !== args.token);
    saveStore();
    return { ok: true };
  },
};
