import express, { Request, Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { verifyCloudRequest } from './server/firebase-auth.ts';
import { boardHandlers } from './server/handlers/board.ts';
import { coreHandlers } from './server/handlers/core.ts';
import { financeHandlers } from './server/handlers/finance.ts';
import { inventoryHandlers } from './server/handlers/inventory.ts';
import { partyHandlers } from './server/handlers/parties.ts';
import { renderDocumentHtml, renderStatementHtml } from './server/handlers/print.ts';
import { settingsHandlers } from './server/handlers/settings.ts';
import { renderAtelierAppHtml, renderAtelierLoginHtml } from './server/html.ts';
import {
  ShardName,
  createBlankWorkshopData,
  createDemoWorkshopData,
  splitStoreToShards,
} from './server/shards.ts';
import {
  AtelierError,
  UPLOADS_DIR,
  ensureDirs,
  getStore,
  getTenantRuntime,
  getUserByEmail,
  hydrateTenantStore,
  nextId,
  nowDateTime,
  resetStore,
  runWithTenantContext,
  saveStore,
} from './server/store.ts';
import { AppRole, UserAccount } from './server/types.ts';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_ATELIER = path.resolve(process.cwd(), 'public', 'atelier');

ensureDirs();

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

function isValidTenantId(id: string): boolean {
  return typeof id === 'string' && id.length >= 2 && id.length <= 64 && /^[a-z0-9-]+$/.test(id);
}

function getTenantHeader(req: Request): string {
  const fromHeader = String(req.headers['x-atelier-tenant'] || '').trim().toLowerCase();
  if (fromHeader) return fromHeader;
  const fromQuery = typeof req.query?.tenant === 'string' ? req.query.tenant.trim().toLowerCase() : '';
  return fromQuery;
}

// Static assets matching Atelier's /assets/atelier/atelier/* paths
app.use('/assets/atelier/atelier', express.static(PUBLIC_ATELIER, { maxAge: 0, etag: true }));
app.use('/files', express.static(UPLOADS_DIR, { maxAge: '1d' }));

app.get('/atelier-sw.js', (_req, res) => {
  const swPath = path.join(PUBLIC_ATELIER, 'atelier-sw.js');
  if (fs.existsSync(swPath)) {
    res.setHeader('Service-Worker-Allowed', '/');
    res.type('application/javascript').sendFile(swPath);
  } else {
    res.status(404).end();
  }
});

// Manifest also accessible from root for broad PWA install compatibility
app.get('/manifest.webmanifest', (_req, res) => {
  const mPath = path.join(PUBLIC_ATELIER, 'manifest.webmanifest');
  if (fs.existsSync(mPath)) {
    res.type('application/manifest+json').sendFile(mPath);
  } else {
    res.status(404).end();
  }
});

// Cloud Multi-Tenant Seed Generator (returns clean blank, demo, or migrated shards for Firestore persistence)
app.post('/api/cloud/seed-shards', async (req: Request, res: Response) => {
  const cloudUser = await verifyCloudRequest(req);
  if (!cloudUser) {
    return res.status(401).json({ error: 'يرجى تسجيل الدخول بحساب Google أولًا' });
  }
  const mode = String(req.body?.seedMode || 'blank');
  const opts = {
    name: String(req.body?.name || 'مطبعة رقمي').trim(),
    city: String(req.body?.city || '').trim(),
    phone: String(req.body?.phone || '').trim(),
    ownerEmail: String(req.body?.ownerEmail || cloudUser.email).trim().toLowerCase(),
    ownerName: String(req.body?.ownerName || cloudUser.displayName).trim(),
  };

  let storeData;
  if (mode === 'migrate-current' && cloudUser.isSuperAdmin) {
    const current = structuredClone(getStore());
    if (opts.name) current.profile.name_ar = opts.name;
    const ownerEmail = opts.ownerEmail;
    const existing = current.users.find((u) => u.email.toLowerCase() === ownerEmail);
    if (existing) {
      existing.role = 'manager';
      existing.enabled = 1;
      existing.full_name = opts.ownerName || existing.full_name;
    } else {
      current.users.unshift({
        name: ownerEmail,
        email: ownerEmail,
        full_name: opts.ownerName || 'نذير عوف',
        role: 'manager',
        enabled: 1,
        password: '',
        ui_scale: 1,
      });
    }
    if (!current.team.some((m) => (m.user || '').toLowerCase() === ownerEmail)) {
      current.team.unshift({ name: opts.ownerName || 'نذير عوف', role: 'مدير', user: ownerEmail });
    }
    storeData = current;
  } else if (mode === 'demo') {
    storeData = createDemoWorkshopData(opts);
  } else {
    storeData = createBlankWorkshopData(opts);
  }

  return res.json({ ok: true, shards: splitStoreToShards(storeData) });
});

// Cloud Multi-Tenant Hydrate (loads tenant's Firestore-verified shards into isolated request runtime)
app.post('/api/cloud/hydrate', async (req: Request, res: Response) => {
  const cloudUser = await verifyCloudRequest(req);
  if (!cloudUser) {
    return res.status(401).json({ exc_type: 'SessionExpired', message: 'يرجى تسجيل الدخول بحساب Google' });
  }
  const tenantId = String(req.body?.tenantId || '').trim().toLowerCase();
  if (!isValidTenantId(tenantId)) {
    return res.status(400).json({ message: 'معرّف المطبعة غير صالح' });
  }
  const roleRaw = String(req.body?.role || 'sales') as AppRole;
  const validRoles: AppRole[] = ['manager', 'sales', 'accountant', 'designer', 'production'];
  const role: AppRole = cloudUser.isSuperAdmin
    ? 'manager'
    : validRoles.includes(roleRaw)
      ? roleRaw
      : 'sales';
  const version = Math.max(1, Number(req.body?.version) || 1);
  const shards = (req.body?.shards || {}) as Partial<Record<ShardName, Record<string, any>>>;

  const entry = hydrateTenantStore({
    tenantId,
    uid: cloudUser.uid,
    email: cloudUser.email,
    displayName: String(req.body?.displayName || cloudUser.displayName),
    role,
    version,
    shards,
    isSuperAdmin: cloudUser.isSuperAdmin,
  });

  return res.json({ ok: true, tenantId: entry.tenantId, version: entry.version });
});

// Logout endpoint (client clears Firebase Auth + service worker caches)
app.all('/api/method/logout', (_req: Request, res: Response) => {
  return res.json({ message: 'ok' });
});

// Tenant-isolated cloud file upload (memory storage -> persisted to Firestore /tenants/{tenantId}/files/{fileId})
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 550 * 1024 }, // Keep base64 safely within Firestore 1MB document limit
});

app.post('/api/method/upload_file', (req: Request, res: Response) => {
  upload.single('file')(req, res, async (multerErr: any) => {
    if (multerErr) {
      if (multerErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          exception: 'ValidationError: حجم الملف يتجاوز الحد المسموح للحفظ السحابي (500 ك.ب). يرجى ضغط الصورة أو اختيار ملف أصغر.',
          _server_messages: JSON.stringify([
            JSON.stringify({ message: 'حجم الملف يتجاوز 500 ك.ب. يرجى تصغير الصورة قبل الرفع.' }),
          ]),
        });
      }
      return res.status(400).json({ exception: 'تعذّر قراءة الملف المرفق' });
    }

    const cloudUser = await verifyCloudRequest(req);
    if (!cloudUser) {
      return res.status(401).json({ exc_type: 'SessionExpired', message: 'يرجى تسجيل الدخول' });
    }
    const tenantId = getTenantHeader(req);
    const runtime = isValidTenantId(tenantId) ? getTenantRuntime(tenantId) : undefined;
    if (!runtime || (!cloudUser.isSuperAdmin && !runtime.authorizedUids.has(cloudUser.uid))) {
      return res.status(409).json({ exc_type: 'NeedHydrate', message: 'جارٍ مزامنة بيانات المطبعة…' });
    }

    const f = req.file;
    if (!f) return res.status(400).json({ exception: 'لم يتم إرفاق ملف' });

    const fileName = Buffer.from(f.originalname, 'latin1').toString('utf8') || f.originalname;
    const mimeType = f.mimetype || 'application/octet-stream';
    const dataUrl = `data:${mimeType};base64,${f.buffer.toString('base64')}`;
    const doctype = String(req.body?.doctype || '');
    const docname = String(req.body?.docname || '');

    try {
      const exec = runWithTenantContext(tenantId, () => {
        const s = getStore();
        const fileId = nextId('FILE');
        const record = {
          name: fileId,
          file_name: fileName,
          file_url: dataUrl,
          file_size: f.size,
          is_private: 0,
          attached_to_doctype: doctype,
          attached_to_name: docname,
          atelier_kind: '',
          creation: nowDateTime(),
          owner: cloudUser.email,
        };
        s.files.unshift(record);
        saveStore();
        return { fileId, record };
      });

      runtime.filesData.set(exec.result.fileId, { mimeType, dataUrl });
      return res.json({
        message: exec.result.record,
        _cloud_file: {
          id: exec.result.fileId,
          fileName,
          mimeType,
          fileSize: f.size,
          dataUrl,
          attachedToDoctype: doctype,
          attachedToName: docname,
        },
        _cloud_sync: exec.mutated
          ? { tenantId, version: exec.version, changedShards: exec.changedShards }
          : undefined,
      });
    } catch (err: any) {
      return res.status(500).json({ exception: err?.message || 'تعذّر حفظ الملف' });
    }
  });
});

// Tenant-isolated Print / PDF endpoints (token + tenant verified)
async function handlePrintRoute(
  req: Request,
  res: Response,
  renderFn: () => string
) {
  const cloudUser = await verifyCloudRequest(req);
  if (!cloudUser) {
    return res.status(401).type('text/html; charset=utf-8').send(
      '<!doctype html><html lang="ar" dir="rtl"><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>يرجى تسجيل الدخول أولًا لعرض المستند.</h2></body></html>'
    );
  }
  const tenantId = getTenantHeader(req);
  const runtime = isValidTenantId(tenantId) ? getTenantRuntime(tenantId) : undefined;
  if (!runtime || (!cloudUser.isSuperAdmin && !runtime.authorizedUids.has(cloudUser.uid))) {
    return res.status(403).type('text/html; charset=utf-8').send(
      '<!doctype html><html lang="ar" dir="rtl"><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>لا تملك صلاحية عرض مستندات هذه المطبعة.</h2></body></html>'
    );
  }
  try {
    const exec = runWithTenantContext(tenantId, renderFn);
    return res.type('text/html; charset=utf-8').send(exec.result);
  } catch (err: any) {
    return res.status(500).type('text/html; charset=utf-8').send(
      `<!doctype html><html lang="ar" dir="rtl"><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>تعذّر تجهيز المستند للطباعة</h2><p>${String(err?.message || '')}</p></body></html>`
    );
  }
}

app.get('/api/method/atelier.api.pdf', (req: Request, res: Response) => {
  const doctype = String(req.query.doctype || 'Sales Order');
  const name = String(req.query.name || '');
  const kind = req.query.kind ? String(req.query.kind) : undefined;
  return handlePrintRoute(req, res, () => renderDocumentHtml(doctype, name, kind));
});

app.get('/api/method/atelier.api.statement_pdf', (req: Request, res: Response) => {
  const name = String(req.query.name || '');
  return handlePrintRoute(req, res, () => renderStatementHtml(name));
});

app.get('/api/method/frappe.utils.print_format.download_pdf', (req: Request, res: Response) => {
  const doctype = String(req.query.doctype || 'Payment Entry');
  const name = String(req.query.name || '');
  return handlePrintRoute(req, res, () => renderDocumentHtml(doctype, name));
});

// Unified RPC method map (100% of Atelier's hardened accounting, board, stock, prices, and settings logic)
const HANDLERS: Record<string, (args: Record<string, any>, user: UserAccount) => any> = {
  ...coreHandlers,
  ...boardHandlers,
  ...partyHandlers,
  ...financeHandlers,
  ...inventoryHandlers,
  ...settingsHandlers,
  reset_demo: () => {
    resetStore();
    return { ok: true };
  },
};

// Dispatch all /api/method/atelier.api.<method> calls (GET & POST) inside isolated tenant context
app.all('/api/method/atelier.api.:method', async (req: Request, res: Response) => {
  const method = String(req.params.method || '');
  const cloudUser = await verifyCloudRequest(req);
  if (!cloudUser) {
    return res.status(401).json({ exc_type: 'SessionExpired', message: 'يرجى تسجيل الدخول بحساب Google' });
  }

  const tenantId = getTenantHeader(req);
  if (!isValidTenantId(tenantId)) {
    return res.status(400).json({ exc_type: 'NoTenant', message: 'لم يتم تحديد المطبعة النشطة' });
  }

  const runtime = getTenantRuntime(tenantId);
  if (!runtime || (!cloudUser.isSuperAdmin && !runtime.authorizedUids.has(cloudUser.uid))) {
    return res.status(409).json({ exc_type: 'NeedHydrate', message: 'جارٍ مزامنة بيانات المطبعة…' });
  }

  const handler = HANDLERS[method];
  if (!handler) {
    console.warn(`[atelier] Unimplemented API method: ${method}`);
    return res.status(404).json({
      exception: `MethodError: الدالة غير متوفرة (${method})`,
      _server_messages: JSON.stringify([JSON.stringify({ message: `الدالة غير متوفرة: ${method}` })]),
    });
  }

  try {
    const args: Record<string, any> = {
      ...(req.query as Record<string, any>),
      ...(req.body && typeof req.body === 'object' ? req.body : {}),
    };

    const exec = runWithTenantContext(tenantId, () => {
      const user = getUserByEmail(cloudUser.email);
      return handler(args, user);
    });

    const payload: Record<string, any> = { message: exec.result };
    if (exec.mutated) {
      payload._cloud_sync = {
        tenantId,
        version: exec.version,
        changedShards: exec.changedShards,
      };
    }
    if (method === 'save_user' && exec.result?.email) {
      payload._invite_sync = {
        email: exec.result.email,
        full_name: exec.result.full_name,
        role: exec.result.role,
        enabled: exec.result.enabled,
      };
    }
    return res.json(payload);
  } catch (err: any) {
    if (err instanceof AtelierError) {
      return res.status(err.status).json({
        exception: `ValidationError: ${err.message}`,
        errors: err.errors,
        _server_messages: JSON.stringify([JSON.stringify({ message: err.message })]),
      });
    }
    console.error(`[atelier] Error in ${method}:`, err);
    return res.status(500).json({
      exception: `ServerError: ${err?.message || 'حدث خطأ غير متوقع'}`,
      _server_messages: JSON.stringify([JSON.stringify({ message: err?.message || 'حدث خطأ غير متوقع' })]),
    });
  }
});

// Login page (Google Sign-In + Closed SaaS Access Gate)
app.get('/atelier-login', (_req, res) => {
  res.type('text/html; charset=utf-8').send(renderAtelierLoginHtml());
});

// Main Atelier SPA routes (client-side Firebase Auth handles session gate cleanly)
app.get('/', (_req, res) => {
  return res.redirect('/atelier');
});

app.get(['/atelier', '/atelier/*'], (_req, res) => {
  return res.type('text/html; charset=utf-8').send(renderAtelierAppHtml());
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Atelier · رقمي Cloud SaaS server running at http://0.0.0.0:${PORT}/atelier`);
});
