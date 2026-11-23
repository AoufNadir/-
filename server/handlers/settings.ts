import {
  AtelierError,
  getStore,
  nowDateTime,
  num,
  parseJsonArg,
  saveStore,
  todayISO,
} from '../store.ts';
import { AppRole, UserAccount } from '../types.ts';

function needManager(user: UserAccount) {
  if (user.role !== 'manager') throw new AtelierError('هذا الإعداد للمدير فقط', 403);
}

export const settingsHandlers: Record<string, (args: Record<string, any>, user: UserAccount) => any> = {
  settings(_args, user) {
    needManager(user);
    const s = getStore();
    const users = s.users.map((u) => ({
      name: u.email,
      email: u.email,
      full_name: u.full_name,
      enabled: u.enabled,
      role: u.role,
      member: s.team.find((m) => m.user === u.email)?.name || null,
    }));
    const funds = s.funds.map((f) => ({
      name: f.name,
      account_name: f.account_name,
      account_type: f.account_type,
    }));
    return {
      profile: s.profile,
      docs: s.docs,
      alerts: s.alerts,
      users,
      funds,
      all_funds: funds,
      modes: s.modes,
      backups: s.backups,
      email: s.email,
      folders: s.folders,
    };
  },

  save_profile(args, user) {
    needManager(user);
    const s = getStore();
    const p = parseJsonArg<Record<string, any>>(args.profile, {});
    s.profile = {
      ...s.profile,
      name_ar: String(p.name_ar ?? s.profile.name_ar).trim(),
      name_fr: String(p.name_fr ?? s.profile.name_fr).trim(),
      address: String(p.address ?? s.profile.address).trim(),
      city: String(p.city ?? s.profile.city).trim(),
      phone: String(p.phone ?? s.profile.phone).trim(),
      phone2: String(p.phone2 ?? s.profile.phone2).trim(),
      email: String(p.email ?? s.profile.email).trim(),
      rc: String(p.rc ?? s.profile.rc).trim(),
      nif: String(p.nif ?? s.profile.nif).trim(),
      nis: String(p.nis ?? s.profile.nis).trim(),
      ai: String(p.ai ?? s.profile.ai).trim(),
      rib: String(p.rib ?? s.profile.rib).trim(),
      logo: String(p.logo ?? s.profile.logo).trim(),
    };
    saveStore();
    return s.profile;
  },

  save_doc_settings(args, user) {
    needManager(user);
    const s = getStore();
    const d = parseJsonArg<Record<string, any>>(args.docs, {});
    s.docs = {
      tva: num(d.tva, s.docs.tva) ? 1 : 0,
      tva_rate: num(d.tva_rate, s.docs.tva_rate || 19),
      footer: String(d.footer ?? s.docs.footer),
      payment_days: Math.max(0, num(d.payment_days, s.docs.payment_days)),
      quote_days: Math.max(1, num(d.quote_days, s.docs.quote_days)),
      show_description: num(d.show_description, s.docs.show_description) ? 1 : 0,
    };
    saveStore();
    return s.docs;
  },

  save_alerts(args, user) {
    needManager(user);
    const s = getStore();
    const a = parseJsonArg<Record<string, any>>(args.alerts, {});
    s.alerts = {
      late_days: num(a.late_days, s.alerts.late_days),
      away_days: num(a.away_days, s.alerts.away_days),
      low_stock: num(a.low_stock, s.alerts.low_stock) ? 1 : 0,
      unpaid_days: num(a.unpaid_days, s.alerts.unpaid_days),
    };
    saveStore();
    return s.alerts;
  },

  save_email(args, user) {
    needManager(user);
    const s = getStore();
    const c = parseJsonArg<Record<string, any>>(args.cfg, {});
    s.email = {
      configured: c.email_id && c.smtp_server ? 1 : 0,
      email_id: String(c.email_id || '').trim(),
      smtp_server: String(c.smtp_server || '').trim(),
      smtp_port: num(c.smtp_port, 587),
      security: (c.security || 'tls') as 'tls' | 'ssl' | 'none',
      login_id: String(c.login_id || c.email_id || '').trim(),
      has_password: c.password ? 1 : s.email.has_password,
    };
    saveStore();
    return s.email;
  },

  test_email(args, user) {
    needManager(user);
    const s = getStore();
    if (!s.email.configured) throw new AtelierError('اضبط إعدادات البريد الصادر أولًا');
    return { ok: true, to: args.to || s.email.email_id };
  },

  save_folders(args, user) {
    needManager(user);
    const s = getStore();
    const d = parseJsonArg<Record<string, any>>(args.data ?? args, {});
    s.folders = {
      ...s.folders,
      enabled: d.enabled !== undefined ? (num(d.enabled) ? 1 : 0) : s.folders.enabled,
      root: String(d.root ?? s.folders.root),
      pattern: String(d.pattern ?? s.folders.pattern),
    };
    saveStore();
    return s.folders;
  },

  sync_folders(_args, user) {
    needManager(user);
    const s = getStore();
    s.folders.last_sync = nowDateTime();
    saveStore();
    return { synced: s.orders.length, last_sync: s.folders.last_sync };
  },

  save_calendar(args, user) {
    needManager(user);
    const s = getStore();
    s.calendar = {
      day_limit: Math.max(1, num(args.day_limit, 5)),
      off_days: parseJsonArg<number[]>(args.off_days, [5]),
    };
    saveStore();
    return s.calendar;
  },

  save_list(args, user) {
    needManager(user);
    const s = getStore();
    const key = String(args.key || '');
    const rows = parseJsonArg<any[]>(args.rows, []);
    if (key === 'units') {
      s.units = rows;
    } else {
      s.lists[key] = rows;
    }
    saveStore();
    return rows;
  },

  save_list_item(args, user) {
    needManager(user);
    const s = getStore();
    const key = String(args.key || '');
    const old = String(args.old || '');
    const row = parseJsonArg<any>(args.row, {});
    const target = key === 'units' ? s.units : (s.lists[key] ||= []);
    const idx = old ? target.findIndex((x: any) => x.name === old || x.value === old) : -1;
    if (idx >= 0) target[idx] = { ...target[idx], ...row };
    else target.push(row);
    saveStore();
    return target;
  },

  delete_list_item(args, user) {
    needManager(user);
    const s = getStore();
    const key = String(args.key || '');
    const name = String(args.name || '');
    if (key === 'units') {
      s.units = s.units.filter((u) => u.name !== name);
      saveStore();
      return s.units;
    }
    s.lists[key] = (s.lists[key] || []).filter((x: any) => x.name !== name && x.value !== name);
    saveStore();
    return s.lists[key];
  },

  save_units(args, user) {
    needManager(user);
    const s = getStore();
    s.units = parseJsonArg<any[]>(args.rows, s.units);
    saveStore();
    return s.units;
  },

  save_stock_section(args, user) {
    return settingsHandlers.save_list_item(
      { key: 'stock_sections', old: args.old, row: { name: args.name, way: args.way || 'count', color: args.color || '#2E90FA' } },
      user
    );
  },

  delete_stock_section(args, user) {
    return settingsHandlers.delete_list_item({ key: 'stock_sections', name: args.name }, user);
  },

  team() {
    return getStore().team;
  },

  save_team(args, user) {
    needManager(user);
    const s = getStore();
    const members = parseJsonArg<any[]>(args.members, []);
    s.team = members
      .filter((m) => String(m.name || '').trim())
      .map((m) => ({ name: String(m.name).trim(), role: String(m.role || ''), user: m.user || null }));
    saveStore();
    return s.team;
  },

  team_accounts() {
    const s = getStore();
    return s.users.map((u) => ({
      name: u.email,
      email: u.email,
      full_name: u.full_name,
      role: u.role,
      enabled: u.enabled,
    }));
  },

  save_user(args, user) {
    needManager(user);
    const s = getStore();
    const email = String(args.email || '').trim().toLowerCase();
    const fullName = String(args.full_name || '').trim();
    const role = (args.role || 'sales') as AppRole;
    const enabled = num(args.enabled, 1) ? 1 : 0;
    if (!email || !fullName) throw new AtelierError('اكتب الاسم والبريد الإلكتروني');

    let acc = s.users.find((u) => u.email.toLowerCase() === email);
    if (!acc) {
      acc = { name: email, email, full_name: fullName, role, enabled, password: 'atelier123', ui_scale: 1 };
      s.users.push(acc);
      if (role === 'sales') {
        s.funds.push({
          name: `CASH-${Date.now().toString(36).toUpperCase()}`,
          account_name: `صندوق ${fullName}`,
          account_type: 'Cash',
          user: email,
        });
      }
    } else {
      acc.full_name = fullName;
      acc.role = role;
      acc.enabled = enabled;
    }
    saveStore();
    return { email: acc.email, full_name: acc.full_name, role: acc.role, enabled: acc.enabled };
  },

  add_to_team(args, user) {
    needManager(user);
    const s = getStore();
    const acc = s.users.find((u) => u.email === args.email);
    if (!acc) throw new AtelierError('الحساب غير موجود');
    if (!s.team.some((m) => m.user === acc.email)) {
      const roleLabels: Record<AppRole, string> = {
        manager: 'مدير',
        sales: 'استقبال',
        designer: 'مصمم',
        production: 'طابع',
        accountant: 'محاسبة',
      };
      s.team.push({ name: acc.full_name, role: roleLabels[acc.role] || '', user: acc.email });
      saveStore();
    }
    return s.team;
  },

  reset_link(args, user) {
    needManager(user);
    return { link: `/atelier-login?reset=${encodeURIComponent(String(args.email || ''))}` };
  },

  add_fund(args, user) {
    needManager(user);
    const s = getStore();
    const label = String(args.label || '').trim();
    if (!label) throw new AtelierError('اكتب اسم الصندوق أو الحساب');
    const fundType = args.fund_type === 'Bank' ? 'Bank' : 'Cash';
    const fund = {
      name: `${fundType.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
      account_name: label,
      account_type: fundType as 'Cash' | 'Bank',
      user: null,
    };
    s.funds.push(fund);
    saveStore();
    return fund;
  },

  rename_fund(args, user) {
    needManager(user);
    const s = getStore();
    const f = s.funds.find((x) => x.name === args.account);
    if (!f) throw new AtelierError('الصندوق غير موجود');
    const label = String(args.label || '').trim();
    if (!label) throw new AtelierError('اكتب الاسم');
    f.account_name = label;
    saveStore();
    return f;
  },

  remove_fund(args, user) {
    needManager(user);
    const s = getStore();
    if (args.account === 'CASH-MAIN') throw new AtelierError('لا يمكن حذف الصندوق الرئيسي');
    s.funds = s.funds.filter((f) => f.name !== args.account);
    saveStore();
    return { ok: true };
  },

  add_mode(args, user) {
    needManager(user);
    const s = getStore();
    const label = String(args.label || '').trim();
    if (!label) throw new AtelierError('اكتب اسم طريقة الدفع');
    const value = `MODE-${Date.now().toString(36).toUpperCase()}`;
    const mode = { value, label, account: args.account || 'CASH-MAIN' };
    s.modes.push(mode);
    saveStore();
    return mode;
  },

  set_mode_account(args, user) {
    needManager(user);
    const s = getStore();
    const m = s.modes.find((x) => x.value === args.mode);
    if (!m) throw new AtelierError('طريقة الدفع غير موجودة');
    if (args.account) m.account = args.account;
    if (args.label) m.label = String(args.label).trim();
    saveStore();
    return m;
  },

  remove_mode(args, user) {
    needManager(user);
    const s = getStore();
    s.modes = s.modes.filter((m) => m.value !== args.value);
    saveStore();
    return { ok: true };
  },

  backup_now(_args, user) {
    needManager(user);
    const s = getStore();
    const json = JSON.stringify(s);
    const item = {
      name: `atelier-backup-${todayISO()}-${Date.now().toString().slice(-4)}.json`,
      date: nowDateTime(),
      size: Buffer.byteLength(json, 'utf-8'),
    };
    s.backups.unshift(item);
    saveStore();
    return item;
  },
};
