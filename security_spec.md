# Atelier · رقمي — Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Closed SaaS Provisioning**: Only Platform Super Admin (`nadiraouf16@gmail.com` with `email_verified == true` or registered in `/admins/{uid}`) can create or delete `/tenants/{tenantId}` or modify subscription fields (`plan`, `status`, `expiresAt`, `maxUsers`, `ownerEmail`).
2. **Master Gate Tenant Isolation**: Access to `/tenants/{tenantId}/workspace/{shardId}` and `/tenants/{tenantId}/files/{fileId}` requires BOTH an existing active `/tenants/{tenantId}` document (`status in ['active', 'trial']`) AND an active `/tenants/{tenantId}/members/{uid}` record (`status == 'active'`). Suspending a tenant or disabling a member immediately revokes all access.
3. **Zero Self-Promotion**: Users cannot create `/admins/{uid}`, cannot self-insert into `/tenants/{tenantId}/members/{uid}` without a matching `pending` `/invites/{inviteId}` addressed to their verified email and atomically transitioning that invite to `accepted` via `getAfter`, and cannot change their own `role`.
4. **PII Isolation**: `/users/{uid}` is readable only by `request.auth.uid == uid` or Super Admin. `/invites/{inviteId}` list queries are strictly restricted to `resource.data.email == request.auth.token.email` (or Super Admin).
5. **Immutable Audit Trail**: `/platform_audit_logs/{logId}` is append-only by Super Admin; updates and deletes are unconditionally denied.
6. **Temporal & Structural Integrity**: `createdAt` is immutable on update and validated against `request.time` on create; `updatedAt` is validated against `request.time` on write; every string enforces `.size()` limits and every document ID enforces `isValidId()`.

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Return PERMISSION_DENIED)
1. **Shadow Field Injection on `/users/{uid}`**: `{ uid, email, displayName, createdAt, lastLoginAt, isAdmin: true }` -> Rejected by `hasOnly`.
2. **Self-Creation of Tenant by Non-Admin**: Non-admin `create` at `/tenants/hacked-print` -> Rejected by `isSuperAdmin()`.
3. **Cross-Tenant Workspace Read**: Active member of `tenant-a` reads `/tenants/tenant-b/workspace/finance` -> Rejected by Master Gate.
4. **Suspended Tenant Write**: Active member of `tenant-a` writes `/tenants/tenant-a/workspace/orders` when `tenant-a.status == 'suspended'` -> Rejected by Master Gate.
5. **Role Escalation via Invite Claim**: Invitee with `role: 'sales'` attempts to create `/tenants/tenant-a/members/{uid}` with `role: 'manager'` -> Rejected by invite role match invariant.
6. **Orphaned Invite Claim (Non-Atomic)**: Invitee creates `/tenants/tenant-a/members/{uid}` without updating `/invites/{inviteId}` to `status: 'accepted'` -> Rejected by `getAfter` Atomicity Guarantee.
7. **Email Spoofing Attack**: Unverified account (`email_verified: false`) with `email: 'nadiraouf16@gmail.com'` attempts admin read/write -> Rejected by `email_verified == true`.
8. **Manager Subscription Tampering**: Workshop manager attempts to update `expiresAt` or `status` on `/tenants/{tenantId}` -> Rejected by `affectedKeys().hasOnly(['name', 'city', 'phone', 'updatedAt'])`.
9. **ID Poisoning / DoW**: Creating `/tenants/{tenantId}/files/{1500-char-id}` -> Rejected by `isValidId(fileId)`.
10. **PII Blanket Read**: Authenticated user A reads `/users/{userB}` -> Rejected by `isOwner(userId)`.
11. **Unscoped List Scraping**: Authenticated non-admin lists `/user_memberships` without `where('uid', '==', auth.uid)` -> Rejected by `resource.data.uid == request.auth.uid`.
12. **Audit Log Tampering**: Super Admin or user attempts `update` or `delete` on `/platform_audit_logs/{logId}` -> Rejected by `allow update, delete: if false`.
