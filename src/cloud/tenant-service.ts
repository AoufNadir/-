import {
  Unsubscribe,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  OperationType,
  SUPER_ADMIN_EMAIL,
  User,
  db,
  handleFirestoreError,
} from './firebase.ts';

export type AppRole = 'manager' | 'sales' | 'accountant' | 'designer' | 'production';
export type TenantPlan = 'starter' | 'pro' | 'enterprise';
export type TenantStatus = 'active' | 'suspended' | 'trial';
export type ShardName = 'meta' | 'people' | 'catalog' | 'orders' | 'finance' | 'inventory';

export const SHARD_NAMES: ShardName[] = ['meta', 'people', 'catalog', 'orders', 'finance', 'inventory'];

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  city?: string;
  phone?: string;
  plan: TenantPlan;
  status: TenantStatus;
  expiresAt: string;
  maxUsers: number;
  ownerEmail: string;
  notes?: string;
  seedMode: 'blank' | 'demo';
  createdByUid: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface MembershipRecord {
  uid: string;
  tenantId: string;
  tenantName: string;
  role: AppRole;
  status: 'active' | 'disabled';
  tenant?: TenantRecord;
  isExpired?: boolean;
  isSuspended?: boolean;
}

export interface AuditLogRecord {
  id: string;
  action: string;
  tenantId?: string;
  tenantName?: string;
  actorUid: string;
  actorEmail: string;
  details: string;
  createdAt?: any;
}

export function todayISO(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function addDaysISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isSuperAdminUser(user: User | null): boolean {
  if (!user || !user.email || !user.emailVerified) return false;
  return user.email.trim().toLowerCase() === SUPER_ADMIN_EMAIL;
}

function hashStringHex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function makeInviteId(tenantId: string, email: string): string {
  const cleanEmail = email.trim().toLowerCase();
  const safeTenant = tenantId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  return `${safeTenant}__${hashStringHex(cleanEmail)}`;
}

export function makeTenantSlug(name: string, customSlug?: string): string {
  const raw = (customSlug || name || '').trim().toLowerCase();
  const ascii = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (ascii.length >= 3) return ascii;
  const suffix = Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);
  return `atelier-${suffix}`;
}

export function sanitizePayload(val: any): any {
  if (val === undefined) return null;
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    return val.map((item) => (item === undefined ? null : sanitizePayload(item)));
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    if (v !== undefined) out[k] = sanitizePayload(v);
  }
  return out;
}

export async function syncUserProfile(user: User): Promise<void> {
  const email = (user.email || '').trim().toLowerCase();
  const displayName = ((user.displayName || '').trim() || (email.split('@')[0] || '').trim() || 'مستخدم').slice(0, 120);
  const photoURL = (user.photoURL || '').trim().slice(0, 500);
  const userRef = doc(db, 'users', user.uid);
  const path = `users/${user.uid}`;

  let snap;
  try {
    snap = await getDoc(userRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (!snap.exists()) {
    try {
      await setDoc(userRef, {
        uid: user.uid,
        email,
        displayName,
        ...(photoURL ? { photoURL } : {}),
        createdAt: serverTimestamp(),
        lastLoginAt: serverTimestamp(),
      });
      return;
    } catch (createError) {
      // Handle cross-tab race where the profile was created concurrently by another tab
      try {
        const retrySnap = await getDoc(userRef);
        if (retrySnap.exists()) {
          await updateDoc(userRef, {
            displayName,
            ...(photoURL ? { photoURL } : {}),
            lastLoginAt: serverTimestamp(),
          });
          return;
        }
      } catch {
        // Fall through to report the original create error
      }
      handleFirestoreError(createError, OperationType.CREATE, path);
    }
  } else {
    try {
      await updateDoc(userRef, {
        displayName,
        ...(photoURL ? { photoURL } : {}),
        lastLoginAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  }
}

export async function redeemPendingInvites(user: User): Promise<number> {
  const email = (user.email || '').trim().toLowerCase();
  if (!email || !user.emailVerified) return 0;

  let snap;
  try {
    // Query only on email to match security rule allow list without requiring a composite index
    const q = query(collection(db, 'invites'), where('email', '==', email));
    snap = await getDocs(q);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'invites');
  }

  let redeemed = 0;
  for (const invDoc of snap.docs) {
    const inv = invDoc.data() as any;
    if (inv.status !== 'pending') continue;
    const tenantId = String(inv.tenantId || '');
    if (!tenantId) continue;

    try {
      const memberRef = doc(db, 'tenants', tenantId, 'members', user.uid);
      const existingMember = await getDoc(memberRef);
      if (existingMember.exists()) {
        // Already a member — mark invite accepted if still pending
        await updateDoc(invDoc.ref, {
          status: 'accepted',
          updatedAt: serverTimestamp(),
        });
        continue;
      }

      const batch = writeBatch(db);
      const indexKey = `${user.uid}__${tenantId}`;
      const indexRef = doc(db, 'user_memberships', indexKey);
      const displayName = (
        (inv.fullName || '').trim() ||
        (user.displayName || '').trim() ||
        (email.split('@')[0] || '').trim() ||
        'مستخدم'
      ).slice(0, 120);

      batch.set(memberRef, {
        uid: user.uid,
        tenantId,
        email,
        displayName,
        role: inv.role,
        status: 'active',
        inviteId: invDoc.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(indexRef, {
        uid: user.uid,
        tenantId,
        tenantName: String(inv.tenantName || 'مطبعة').slice(0, 120),
        role: inv.role,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.update(invDoc.ref, {
        status: 'accepted',
        updatedAt: serverTimestamp(),
      });

      await batch.commit();
      redeemed += 1;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `invites/${invDoc.id}`);
    }
  }
  return redeemed;
}

export async function writeAuditLog(
  user: User,
  entry: { action: string; tenantId?: string; tenantName?: string; details: string }
): Promise<void> {
  const logId = `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const path = `platform_audit_logs/${logId}`;
  try {
    await setDoc(doc(db, 'platform_audit_logs', logId), {
      action: entry.action.slice(0, 64),
      ...(entry.tenantId ? { tenantId: entry.tenantId.slice(0, 64) } : {}),
      ...(entry.tenantName ? { tenantName: entry.tenantName.slice(0, 120) } : {}),
      actorUid: user.uid,
      actorEmail: (user.email || '').trim().toLowerCase(),
      details: entry.details.slice(0, 1000),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

async function fetchSeedShardsFromServer(
  user: User,
  body: Record<string, any>
): Promise<Record<ShardName, Record<string, any>>> {
  const idToken = await user.getIdToken();
  const res = await fetch('/api/cloud/seed-shards', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'تعذّر تجهيز بيانات المطبعة');
  }
  const data = await res.json();
  return data.shards;
}

export async function ensureSuperAdminDefaultWorkshop(user: User): Promise<void> {
  if (!isSuperAdminUser(user)) return;
  const tenantId = 'atelier-main';
  const tenantRef = doc(db, 'tenants', tenantId);
  try {
    const existing = await getDoc(tenantRef);
    const email = (user.email || '').trim().toLowerCase();
    const displayName = ((user.displayName || '').trim() || 'نذير عوف').slice(0, 120);

    if (existing.exists()) {
      const tData = existing.data() as TenantRecord;
      // Ensure Super Admin has direct membership + index
      const memberRef = doc(db, 'tenants', tenantId, 'members', user.uid);
      const [memberSnap, metaShardSnap] = await Promise.all([
        getDoc(memberRef),
        getDoc(doc(db, 'tenants', tenantId, 'workspace', 'meta')),
      ]);

      const needsMember = !memberSnap.exists();
      const needsShards = !metaShardSnap.exists();

      if (needsMember || needsShards) {
        const shards = needsShards
          ? await fetchSeedShardsFromServer(user, {
              seedMode: 'migrate-current',
              name: tData.name || 'مطبعة رقمي للطباعة والإشهار',
              city: tData.city || 'الجزائر العاصمة',
              phone: tData.phone || '0550 42 18 90',
              ownerEmail: email,
              ownerName: displayName,
            })
          : null;

        const batch = writeBatch(db);
        if (needsMember) {
          batch.set(memberRef, {
            uid: user.uid,
            tenantId,
            email,
            displayName,
            role: 'manager',
            status: 'active',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          batch.set(doc(db, 'user_memberships', `${user.uid}__${tenantId}`), {
            uid: user.uid,
            tenantId,
            tenantName: tData.name || 'مطبعة رقمي',
            role: 'manager',
            status: 'active',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        if (needsShards && shards) {
          for (const shard of SHARD_NAMES) {
            batch.set(doc(db, 'tenants', tenantId, 'workspace', shard), {
              tenantId,
              shard,
              version: 1,
              payload: sanitizePayload(shards[shard] || {}),
              updatedByUid: user.uid,
              updatedAt: serverTimestamp(),
            });
          }
        }
        await batch.commit();
      }
      return;
    }

    const shards = await fetchSeedShardsFromServer(user, {
      seedMode: 'migrate-current',
      name: 'مطبعة رقمي للطباعة والإشهار',
      city: 'الجزائر العاصمة',
      phone: '0550 42 18 90',
      ownerEmail: email,
      ownerName: displayName,
    });

    // Step 1: Create tenant document first (rules verify tenant exists before creating subcollections)
    await setDoc(tenantRef, {
      id: tenantId,
      name: 'مطبعة رقمي للطباعة والإشهار',
      slug: tenantId,
      city: 'الجزائر العاصمة',
      phone: '0550 42 18 90',
      plan: 'enterprise',
      status: 'active',
      expiresAt: addDaysISO(365),
      maxUsers: 25,
      ownerEmail: email,
      notes: 'المطبعة الرئيسية لمالك المنصة (تم ترحيل البيانات تلقائيًا)',
      seedMode: 'demo',
      createdByUid: user.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // Step 2: Create membership + index + 6 workspace shards atomically
    const batch = writeBatch(db);
    batch.set(doc(db, 'tenants', tenantId, 'members', user.uid), {
      uid: user.uid,
      tenantId,
      email,
      displayName,
      role: 'manager',
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'user_memberships', `${user.uid}__${tenantId}`), {
      uid: user.uid,
      tenantId,
      tenantName: 'مطبعة رقمي للطباعة والإشهار',
      role: 'manager',
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    for (const shard of SHARD_NAMES) {
      batch.set(doc(db, 'tenants', tenantId, 'workspace', shard), {
        tenantId,
        shard,
        version: 1,
        payload: sanitizePayload(shards[shard] || {}),
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();

    await writeAuditLog(user, {
      action: 'bootstrap_main_tenant',
      tenantId,
      tenantName: 'مطبعة رقمي للطباعة والإشهار',
      details: 'تهيئة المطبعة الرئيسية الأولى وترحيل البيانات السحابية تلقائيًا.',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `tenants/${tenantId}`);
  }
}

export async function loadUserMemberships(user: User): Promise<MembershipRecord[]> {
  const path = 'user_memberships';
  try {
    const q = query(collection(db, 'user_memberships'), where('uid', '==', user.uid));
    const snap = await getDocs(q);
    const today = todayISO();
    const results: MembershipRecord[] = [];

    for (const d of snap.docs) {
      const m = d.data() as MembershipRecord;
      if (m.status !== 'active') continue;
      let tenant: TenantRecord | undefined;
      try {
        const tSnap = await getDoc(doc(db, 'tenants', m.tenantId));
        if (tSnap.exists()) {
          tenant = tSnap.data() as TenantRecord;
        }
      } catch {
        // Tenant may have been deleted
      }
      if (!tenant) continue;
      const isSuspended = tenant.status === 'suspended';
      const isExpired = Boolean(tenant.expiresAt && today > tenant.expiresAt);
      results.push({
        ...m,
        tenantName: tenant.name || m.tenantName,
        tenant,
        isSuspended,
        isExpired,
      });
    }
    return results;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function loadTenantShardsAndHydrate(
  user: User,
  tenantId: string,
  role: AppRole
): Promise<{ version: number }> {
  const shards: Partial<Record<ShardName, Record<string, any>>> = {};
  let version = 1;

  try {
    const snaps = await Promise.all(
      SHARD_NAMES.map((shard) => getDoc(doc(db, 'tenants', tenantId, 'workspace', shard)))
    );
    snaps.forEach((snap, idx) => {
      const shard = SHARD_NAMES[idx];
      if (snap.exists()) {
        const data = snap.data() as any;
        shards[shard] = data.payload || {};
        if (shard === 'meta' && typeof data.version === 'number') {
          version = Math.max(version, data.version);
        }
      }
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `tenants/${tenantId}/workspace`);
  }

  const idToken = await user.getIdToken();
  const res = await fetch('/api/cloud/hydrate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      tenantId,
      role,
      displayName: user.displayName || (user.email || '').split('@')[0],
      version,
      shards,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'تعذّر تحميل بيانات المطبعة من السحابة');
  }
  return { version };
}

export async function persistChangedShards(
  user: User,
  tenantId: string,
  version: number,
  changedShards: Partial<Record<ShardName, Record<string, any>>>
): Promise<void> {
  const keys = Object.keys(changedShards) as ShardName[];
  if (!keys.length) return;

  const path = `tenants/${tenantId}/workspace`;
  try {
    const batch = writeBatch(db);
    for (const shard of keys) {
      const ref = doc(db, 'tenants', tenantId, 'workspace', shard);
      batch.set(ref, {
        tenantId,
        shard,
        version: Math.max(1, Math.floor(version)),
        payload: sanitizePayload(changedShards[shard] || {}),
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
    }
    // Always bump meta version stamp if meta wasn't already in changedShards so multi-device listener detects updates
    if (!keys.includes('meta')) {
      const metaRef = doc(db, 'tenants', tenantId, 'workspace', 'meta');
      batch.update(metaRef, {
        version: Math.max(1, Math.floor(version)),
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function persistUploadedFile(
  user: User,
  tenantId: string,
  file: {
    id: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    dataUrl: string;
    attachedToDoctype?: string;
    attachedToName?: string;
  }
): Promise<void> {
  const path = `tenants/${tenantId}/files/${file.id}`;
  try {
    await setDoc(doc(db, 'tenants', tenantId, 'files', file.id), {
      id: file.id,
      tenantId,
      fileName: file.fileName.slice(0, 255),
      mimeType: file.mimeType.slice(0, 120),
      fileSize: Math.max(0, Math.floor(file.fileSize)),
      dataUrl: file.dataUrl,
      ...(file.attachedToDoctype ? { attachedToDoctype: file.attachedToDoctype.slice(0, 64) } : {}),
      ...(file.attachedToName ? { attachedToName: file.attachedToName.slice(0, 128) } : {}),
      ownerUid: user.uid,
      ownerEmail: (user.email || '').trim().toLowerCase(),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function syncStaffInvite(
  user: User,
  tenantId: string,
  tenantName: string,
  staff: { email: string; full_name: string; role: AppRole; enabled: number }
): Promise<void> {
  const email = String(staff.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return;
  const inviteId = makeInviteId(tenantId, email);
  const ref = doc(db, 'invites', inviteId);
  const path = `invites/${inviteId}`;

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      if (!staff.enabled) return;
      await setDoc(ref, {
        inviteId,
        tenantId,
        tenantName: tenantName.slice(0, 120),
        email,
        fullName: String(staff.full_name || '').trim().slice(0, 120),
        role: staff.role,
        status: 'pending',
        invitedByUid: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const existing = snap.data() as any;
      if (existing.status === 'pending') {
        await updateDoc(ref, {
          role: staff.role,
          fullName: String(staff.full_name || '').trim().slice(0, 120),
          status: staff.enabled ? 'pending' : 'revoked',
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeTenantMeta(
  tenantId: string,
  getLocalVersion: () => number,
  onRemoteVersion: (remoteVersion: number) => void
): Unsubscribe {
  const path = `tenants/${tenantId}/workspace/meta`;
  return onSnapshot(
    doc(db, 'tenants', tenantId, 'workspace', 'meta'),
    (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() as any;
      const remoteVer = Number(data?.version || 0);
      if (remoteVer > getLocalVersion()) {
        onRemoteVersion(remoteVer);
      }
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

// =========================================================================
// SUPER ADMIN PLATFORM CONSOLE OPERATIONS
// =========================================================================

export async function listAllTenants(): Promise<TenantRecord[]> {
  try {
    const snap = await getDocs(collection(db, 'tenants'));
    return snap.docs
      .map((d) => d.data() as TenantRecord)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ar'));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'tenants');
  }
}

export async function listAllAuditLogs(): Promise<AuditLogRecord[]> {
  try {
    const q = query(collection(db, 'platform_audit_logs'), orderBy('createdAt', 'desc'), limit(50));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AuditLogRecord, 'id'>) }));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'platform_audit_logs');
  }
}

export async function createWorkshopTenant(
  user: User,
  input: {
    name: string;
    slug?: string;
    city?: string;
    phone?: string;
    plan: TenantPlan;
    status: TenantStatus;
    expiresAt: string;
    maxUsers: number;
    ownerEmail: string;
    ownerName?: string;
    notes?: string;
    seedMode: 'blank' | 'demo';
  }
): Promise<TenantRecord> {
  const name = input.name.trim();
  if (name.length < 2) throw new Error('اكتب اسم المطبعة (حرفين على الأقل)');
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  if (!ownerEmail || !ownerEmail.includes('@')) throw new Error('أدخل بريدًا إلكترونيًا صحيحًا لمدير المطبعة');

  let tenantId = makeTenantSlug(name, input.slug);
  const existingCheck = await getDoc(doc(db, 'tenants', tenantId));
  if (existingCheck.exists()) {
    tenantId = `${tenantId.slice(0, 52)}-${Date.now().toString(36).slice(-4)}`;
  }

  const ownerName = (input.ownerName || `مدير ${name}`).trim().slice(0, 120);
  const shards = await fetchSeedShardsFromServer(user, {
    seedMode: input.seedMode,
    name,
    city: input.city || '',
    phone: input.phone || '',
    ownerEmail,
    ownerName,
  });

  const tenantDoc: TenantRecord = {
    id: tenantId,
    name: name.slice(0, 120),
    slug: tenantId,
    city: String(input.city || '').trim().slice(0, 80),
    phone: String(input.phone || '').trim().slice(0, 40),
    plan: input.plan || 'pro',
    status: input.status || 'active',
    expiresAt: input.expiresAt || addDaysISO(365),
    maxUsers: Math.max(1, Math.min(500, Math.floor(Number(input.maxUsers) || 10))),
    ownerEmail,
    notes: String(input.notes || '').trim().slice(0, 1000),
    seedMode: input.seedMode === 'demo' ? 'demo' : 'blank',
    createdByUid: user.uid,
  };

  try {
    // 1. Create Tenant
    await setDoc(doc(db, 'tenants', tenantId), {
      ...tenantDoc,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // 2. Write 6 workspace shards + owner invite (or direct membership if owner is current Super Admin)
    const batch = writeBatch(db);
    for (const shard of SHARD_NAMES) {
      batch.set(doc(db, 'tenants', tenantId, 'workspace', shard), {
        tenantId,
        shard,
        version: 1,
        payload: sanitizePayload(shards[shard] || {}),
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
    }

    if (ownerEmail === (user.email || '').trim().toLowerCase()) {
      batch.set(doc(db, 'tenants', tenantId, 'members', user.uid), {
        uid: user.uid,
        tenantId,
        email: ownerEmail,
        displayName: ownerName,
        role: 'manager',
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'user_memberships', `${user.uid}__${tenantId}`), {
        uid: user.uid,
        tenantId,
        tenantName: tenantDoc.name,
        role: 'manager',
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const inviteId = makeInviteId(tenantId, ownerEmail);
      batch.set(doc(db, 'invites', inviteId), {
        inviteId,
        tenantId,
        tenantName: tenantDoc.name,
        email: ownerEmail,
        fullName: ownerName,
        role: 'manager',
        status: 'pending',
        invitedByUid: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    await batch.commit();

    await writeAuditLog(user, {
      action: 'create_tenant',
      tenantId,
      tenantName: tenantDoc.name,
      details: `إنشاء مطبعة جديدة (${tenantDoc.plan}) للمدير ${ownerEmail} — ينتهي الاشتراك في ${tenantDoc.expiresAt}.`,
    });

    return tenantDoc;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `tenants/${tenantId}`);
  }
}

export async function updateWorkshopTenant(
  user: User,
  tenantId: string,
  updates: {
    name?: string;
    city?: string;
    phone?: string;
    plan?: TenantPlan;
    status?: TenantStatus;
    expiresAt?: string;
    maxUsers?: number;
    ownerEmail?: string;
    notes?: string;
  }
): Promise<void> {
  const ref = doc(db, 'tenants', tenantId);
  const path = `tenants/${tenantId}`;
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error('المطبعة غير موجودة');
    const prev = snap.data() as TenantRecord;

    const nextOwnerEmail = updates.ownerEmail
      ? updates.ownerEmail.trim().toLowerCase()
      : prev.ownerEmail;

    const patch: Record<string, any> = {
      name: (updates.name ?? prev.name).trim().slice(0, 120),
      city: String(updates.city ?? prev.city ?? '').trim().slice(0, 80),
      phone: String(updates.phone ?? prev.phone ?? '').trim().slice(0, 40),
      plan: updates.plan ?? prev.plan,
      status: updates.status ?? prev.status,
      expiresAt: updates.expiresAt ?? prev.expiresAt,
      maxUsers: Math.max(1, Math.min(500, Math.floor(Number(updates.maxUsers ?? prev.maxUsers) || 10))),
      ownerEmail: nextOwnerEmail,
      notes: String(updates.notes ?? prev.notes ?? '').trim().slice(0, 1000),
      updatedAt: serverTimestamp(),
    };

    await updateDoc(ref, patch);

    // If ownerEmail changed, create a pending manager invite for the new owner automatically
    if (nextOwnerEmail !== prev.ownerEmail && nextOwnerEmail !== (user.email || '').trim().toLowerCase()) {
      const inviteId = makeInviteId(tenantId, nextOwnerEmail);
      const invRef = doc(db, 'invites', inviteId);
      const invSnap = await getDoc(invRef);
      if (!invSnap.exists()) {
        await setDoc(invRef, {
          inviteId,
          tenantId,
          tenantName: patch.name,
          email: nextOwnerEmail,
          fullName: `مدير ${patch.name}`,
          role: 'manager',
          status: 'pending',
          invitedByUid: user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    await writeAuditLog(user, {
      action: updates.status && updates.status !== prev.status ? `status_${updates.status}` : 'update_tenant',
      tenantId,
      tenantName: patch.name,
      details: `تحديث بيانات واشتراك المطبعة — الحالة: ${patch.status}، الباقة: ${patch.plan}، الانتهاء: ${patch.expiresAt}.`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
