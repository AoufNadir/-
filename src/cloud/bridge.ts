import { Unsubscribe } from 'firebase/firestore';
import {
  User,
  auth,
  googleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  testConnection,
} from './firebase.ts';
import { pwaManager } from './pwa.ts';
import {
  AppRole,
  AuditLogRecord,
  MembershipRecord,
  ShardName,
  TenantPlan,
  TenantRecord,
  TenantStatus,
  createWorkshopTenant,
  ensureSuperAdminDefaultWorkshop,
  isSuperAdminUser,
  listAllAuditLogs,
  listAllTenants,
  loadTenantShardsAndHydrate,
  loadUserMemberships,
  persistChangedShards,
  persistUploadedFile,
  redeemPendingInvites,
  subscribeTenantMeta,
  syncStaffInvite,
  syncUserProfile,
  todayISO,
  updateWorkshopTenant,
} from './tenant-service.ts';

export type AccessStatus =
  | 'loading'
  | 'unauthenticated'
  | 'ready'
  | 'no_workshop'
  | 'suspended'
  | 'expired'
  | 'error';

export interface CloudSessionSnapshot {
  status: AccessStatus;
  error?: string;
  user: {
    uid: string;
    email: string;
    displayName: string;
    photoURL: string;
  } | null;
  isSuperAdmin: boolean;
  memberships: MembershipRecord[];
  activeTenantId: string | null;
  activeTenant: TenantRecord | null;
  activeRole: AppRole | null;
  blockedTenant?: TenantRecord | null;
  version: number;
  syncing: boolean;
}

const ACTIVE_TENANT_STORAGE_KEY = 'atelier.cloud.activeTenantId';

class AtelierCloudBridge {
  private firebaseUser: User | null = null;
  private metaUnsub: Unsubscribe | null = null;
  private remoteRefreshHandler: (() => void) | null = null;
  private initPromise: Promise<CloudSessionSnapshot> | null = null;
  private resolveInFlight: { key: string; promise: Promise<void> } | null = null;
  private lastResolvedUid: string | null = null;
  private listeners = new Set<(snap: CloudSessionSnapshot) => void>();

  public session: CloudSessionSnapshot = {
    status: 'loading',
    user: null,
    isSuperAdmin: false,
    memberships: [],
    activeTenantId: null,
    activeTenant: null,
    activeRole: null,
    blockedTenant: null,
    version: 1,
    syncing: false,
  };

  public pwa = pwaManager;

  private emit() {
    for (const fn of this.listeners) {
      try {
        fn({ ...this.session });
      } catch {
        // ignore listener failure
      }
    }
  }

  subscribe(fn: (snap: CloudSessionSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn({ ...this.session });
    return () => this.listeners.delete(fn);
  }

  setRemoteRefreshHandler(fn: () => void) {
    this.remoteRefreshHandler = fn;
  }

  init(): Promise<CloudSessionSnapshot> {
    if (this.initPromise) return this.initPromise;
    // Startup connection check required by Firebase guidelines
    testConnection().catch(() => {});

    this.initPromise = new Promise((resolve) => {
      let resolvedOnce = false;
      onAuthStateChanged(auth, async (user) => {
        this.firebaseUser = user;
        if (!user) {
          this.detachMetaListener();
          this.lastResolvedUid = null;
          this.resolveInFlight = null;
          this.session = {
            status: 'unauthenticated',
            user: null,
            isSuperAdmin: false,
            memberships: [],
            activeTenantId: null,
            activeTenant: null,
            activeRole: null,
            blockedTenant: null,
            version: 1,
            syncing: false,
          };
          this.emit();
          if (!resolvedOnce) {
            resolvedOnce = true;
            resolve({ ...this.session });
          }
          return;
        }

        // Avoid re-running if already resolved or in-flight for the same user
        if (this.resolveInFlight && this.resolveInFlight.key.startsWith(`${user.uid}::`)) {
          await this.resolveInFlight.promise;
        } else if (
          this.lastResolvedUid !== user.uid ||
          this.session.status === 'loading' ||
          this.session.status === 'unauthenticated'
        ) {
          await this.resolveUserWorkspace(user);
        }

        if (!resolvedOnce) {
          resolvedOnce = true;
          resolve({ ...this.session });
        }
      });
    });

    return this.initPromise;
  }

  private detachMetaListener() {
    if (this.metaUnsub) {
      try {
        this.metaUnsub();
      } catch {
        // ignore
      }
      this.metaUnsub = null;
    }
  }

  private resolveUserWorkspace(user: User, preferredTenantId?: string | null): Promise<void> {
    const key = `${user.uid}::${preferredTenantId || ''}`;
    if (this.resolveInFlight && this.resolveInFlight.key === key) {
      return this.resolveInFlight.promise;
    }

    const run = this._runResolveUserWorkspace(user, preferredTenantId).finally(() => {
      if (this.resolveInFlight && this.resolveInFlight.key === key) {
        this.resolveInFlight = null;
      }
    });
    this.resolveInFlight = { key, promise: run };
    return run;
  }

  private async _runResolveUserWorkspace(user: User, preferredTenantId?: string | null): Promise<void> {
    const email = (user.email || '').trim().toLowerCase();
    const displayName = ((user.displayName || '').trim() || email.split('@')[0] || 'مستخدم').trim();
    const isSuperAdmin = isSuperAdminUser(user);

    this.detachMetaListener();
    this.session = {
      ...this.session,
      status: 'loading',
      error: undefined,
      user: {
        uid: user.uid,
        email,
        displayName,
        photoURL: user.photoURL || '',
      },
      isSuperAdmin,
    };
    this.emit();

    try {
      await syncUserProfile(user);
      await redeemPendingInvites(user);
      if (isSuperAdmin) {
        await ensureSuperAdminDefaultWorkshop(user);
      }

      let memberships = await loadUserMemberships(user);

      // For Super Admin, also expose all platform workshops in the switcher
      if (isSuperAdmin) {
        const allTenants = await listAllTenants();
        const byId = new Map(memberships.map((m) => [m.tenantId, m]));
        const today = todayISO();
        for (const t of allTenants) {
          if (!byId.has(t.id)) {
            byId.set(t.id, {
              uid: user.uid,
              tenantId: t.id,
              tenantName: t.name,
              role: 'manager',
              status: 'active',
              tenant: t,
              isSuspended: t.status === 'suspended',
              isExpired: Boolean(t.expiresAt && today > t.expiresAt),
            });
          }
        }
        memberships = Array.from(byId.values());
      }

      const savedId =
        preferredTenantId ||
        (() => {
          try {
            return sessionStorage.getItem(ACTIVE_TENANT_STORAGE_KEY) || localStorage.getItem(ACTIVE_TENANT_STORAGE_KEY);
          } catch {
            return null;
          }
        })();

      // Pick accessible workshop (Super Admin can open any workshop; regular users only active & non-expired)
      const usable = isSuperAdmin
        ? memberships
        : memberships.filter((m) => !m.isSuspended && !m.isExpired);

      if (!usable.length) {
        const suspended = memberships.find((m) => m.isSuspended);
        const expired = memberships.find((m) => m.isExpired);
        this.lastResolvedUid = user.uid;
        this.session = {
          ...this.session,
          status: suspended ? 'suspended' : expired ? 'expired' : 'no_workshop',
          memberships,
          activeTenantId: null,
          activeTenant: null,
          activeRole: null,
          blockedTenant: (suspended || expired)?.tenant || null,
        };
        this.emit();
        return;
      }

      const chosen = usable.find((m) => m.tenantId === savedId) || usable[0];
      try {
        localStorage.setItem(ACTIVE_TENANT_STORAGE_KEY, chosen.tenantId);
      } catch {
        // ignore private mode
      }

      const { version } = await loadTenantShardsAndHydrate(user, chosen.tenantId, chosen.role);

      this.lastResolvedUid = user.uid;
      this.session = {
        ...this.session,
        status: 'ready',
        memberships,
        activeTenantId: chosen.tenantId,
        activeTenant: chosen.tenant || null,
        activeRole: isSuperAdmin ? 'manager' : chosen.role,
        blockedTenant: null,
        version,
      };
      this.emit();

      // Attach real-time multi-device update listener on this tenant's meta shard
      this.attachMetaListener(user, chosen.tenantId, isSuperAdmin ? 'manager' : chosen.role);
    } catch (err: any) {
      console.error('[atelier-cloud] Failed to resolve workspace:', err);
      this.lastResolvedUid = null;
      this.session = {
        ...this.session,
        status: 'error',
        error: err?.message || 'تعذّر الاتصال بالسحابة. تحقق من اتصال الإنترنت وأعد المحاولة.',
      };
      this.emit();
    }
  }

  private attachMetaListener(user: User, tenantId: string, role: AppRole) {
    this.detachMetaListener();
    this.metaUnsub = subscribeTenantMeta(
      tenantId,
      () => this.session.version,
      async (remoteVersion) => {
        if (this.session.syncing) return;
        try {
          const { version } = await loadTenantShardsAndHydrate(user, tenantId, role);
          this.session.version = Math.max(version, remoteVersion);
          this.emit();
          if (this.remoteRefreshHandler) this.remoteRefreshHandler();
        } catch (err) {
          console.warn('[atelier-cloud] Remote refresh failed:', err);
        }
      }
    );
  }

  async signInWithGoogle(): Promise<CloudSessionSnapshot> {
    await signInWithPopup(auth, googleAuthProvider);
    const currentUser = auth.currentUser;
    if (currentUser) {
      this.firebaseUser = currentUser;
      // If onAuthStateChanged already kicked off resolution for this user, await the exact same promise
      if (this.resolveInFlight && this.resolveInFlight.key.startsWith(`${currentUser.uid}::`)) {
        await this.resolveInFlight.promise;
      } else if (
        this.lastResolvedUid !== currentUser.uid ||
        this.session.status === 'unauthenticated' ||
        this.session.status === 'error'
      ) {
        await this.resolveUserWorkspace(currentUser);
      }
    }
    return { ...this.session };
  }

  async signOut(): Promise<void> {
    this.detachMetaListener();
    try {
      localStorage.removeItem(ACTIVE_TENANT_STORAGE_KEY);
      sessionStorage.removeItem(ACTIVE_TENANT_STORAGE_KEY);
    } catch {
      // ignore
    }
    // Clear Service Worker caches on logout to prevent any shared-device data residue
    if ('caches' in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        // ignore
      }
    }
    await signOut(auth);
    location.href = '/atelier-login';
  }

  async getIdToken(forceRefresh = false): Promise<string | null> {
    if (!this.firebaseUser) return null;
    try {
      return await this.firebaseUser.getIdToken(forceRefresh);
    } catch {
      return null;
    }
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.getIdToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.session.activeTenantId) headers['X-Atelier-Tenant'] = this.session.activeTenantId;
    return headers;
  }

  async buildPrintUrl(baseUrl: string): Promise<string> {
    const token = await this.getIdToken();
    const u = new URL(baseUrl, location.origin);
    if (this.session.activeTenantId) u.searchParams.set('tenant', this.session.activeTenantId);
    if (token) u.searchParams.set('token', token);
    return u.pathname + u.search;
  }

  async rehydrate(): Promise<void> {
    if (!this.firebaseUser || !this.session.activeTenantId || !this.session.activeRole) return;
    const { version } = await loadTenantShardsAndHydrate(
      this.firebaseUser,
      this.session.activeTenantId,
      this.session.activeRole
    );
    this.session.version = version;
    this.emit();
  }

  async switchTenant(tenantId: string): Promise<void> {
    if (!this.firebaseUser) return;
    await this.resolveUserWorkspace(this.firebaseUser, tenantId);
  }

  async afterApiResponse(responseData: any): Promise<void> {
    if (!this.firebaseUser || !this.session.activeTenantId || !responseData) return;

    const syncInfo = responseData._cloud_sync as
      | { tenantId: string; version: number; changedShards: Partial<Record<ShardName, Record<string, any>>> }
      | undefined;

    if (syncInfo && syncInfo.changedShards && Object.keys(syncInfo.changedShards).length > 0) {
      this.session.syncing = true;
      this.session.version = Math.max(this.session.version, syncInfo.version);
      this.emit();
      try {
        await persistChangedShards(
          this.firebaseUser,
          syncInfo.tenantId,
          syncInfo.version,
          syncInfo.changedShards
        );
      } finally {
        this.session.syncing = false;
        this.emit();
      }
    }

    if (responseData._cloud_file) {
      await persistUploadedFile(this.firebaseUser, this.session.activeTenantId, responseData._cloud_file);
    }

    if (responseData._invite_sync) {
      await syncStaffInvite(
        this.firebaseUser,
        this.session.activeTenantId,
        this.session.activeTenant?.name || 'مطبعة رقمي',
        responseData._invite_sync
      );
    }
  }

  // Super Admin Platform Console API
  admin = {
    listTenants: async (): Promise<TenantRecord[]> => {
      if (!this.session.isSuperAdmin) throw new Error('هذه الصلاحية لمالك المنصة فقط');
      return listAllTenants();
    },
    listAuditLogs: async (): Promise<AuditLogRecord[]> => {
      if (!this.session.isSuperAdmin) throw new Error('هذه الصلاحية لمالك المنصة فقط');
      return listAllAuditLogs();
    },
    createTenant: async (input: {
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
    }): Promise<TenantRecord> => {
      if (!this.firebaseUser || !this.session.isSuperAdmin) {
        throw new Error('هذه الصلاحية لمالك المنصة فقط');
      }
      const created = await createWorkshopTenant(this.firebaseUser, input);
      // Refresh memberships list in session so new tenant appears immediately in switcher
      const all = await listAllTenants();
      const today = todayISO();
      this.session.memberships = all.map((t) => ({
        uid: this.firebaseUser!.uid,
        tenantId: t.id,
        tenantName: t.name,
        role: 'manager',
        status: 'active',
        tenant: t,
        isSuspended: t.status === 'suspended',
        isExpired: Boolean(t.expiresAt && today > t.expiresAt),
      }));
      this.emit();
      return created;
    },
    updateTenant: async (
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
    ): Promise<void> => {
      if (!this.firebaseUser || !this.session.isSuperAdmin) {
        throw new Error('هذه الصلاحية لمالك المنصة فقط');
      }
      await updateWorkshopTenant(this.firebaseUser, tenantId, updates);
      const all = await listAllTenants();
      const today = todayISO();
      this.session.memberships = all.map((t) => ({
        uid: this.firebaseUser!.uid,
        tenantId: t.id,
        tenantName: t.name,
        role: 'manager',
        status: 'active',
        tenant: t,
        isSuspended: t.status === 'suspended',
        isExpired: Boolean(t.expiresAt && today > t.expiresAt),
      }));
      if (this.session.activeTenantId === tenantId) {
        this.session.activeTenant = all.find((t) => t.id === tenantId) || this.session.activeTenant;
      }
      this.emit();
    },
  };
}

declare global {
  interface Window {
    AtelierCloud: AtelierCloudBridge;
  }
}

const bridge = new AtelierCloudBridge();
window.AtelierCloud = bridge;

export default bridge;
