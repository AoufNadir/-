/**
 * Phase 0 Payload-First Security Test Suite for Atelier Multi-Tenant Firestore Rules.
 * Validates the "Dirty Dozen" adversarial payloads and structural rule invariants.
 */
import fs from 'fs';
import path from 'path';

interface AdversarialCase {
  id: number;
  name: string;
  targetPath: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  expected: 'PERMISSION_DENIED';
  guardPattern: RegExp;
}

export const DIRTY_DOZEN_CASES: AdversarialCase[] = [
  {
    id: 1,
    name: 'Shadow Field Injection on /users/{uid}',
    targetPath: '/users/u1',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    guardPattern: /data\.keys\(\)\.hasOnly\(\['uid', 'email', 'displayName', 'photoURL', 'createdAt', 'lastLoginAt'\]\)/,
  },
  {
    id: 2,
    name: 'Self-Creation of Tenant by Non-Admin',
    targetPath: '/tenants/hacked-print',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    guardPattern: /match \/tenants\/\{tenantId\}[\s\S]*allow create: if isSuperAdmin\(\)/,
  },
  {
    id: 3,
    name: 'Cross-Tenant Workspace Read',
    targetPath: '/tenants/tenant-b/workspace/finance',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
    guardPattern: /match \/workspace\/\{shardId\}[\s\S]*isActiveTenantMember\(tenantId\)/,
  },
  {
    id: 4,
    name: 'Suspended Tenant Write',
    targetPath: '/tenants/tenant-a/workspace/orders',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    guardPattern: /function isTenantActive\(tenantId\)[\s\S]*status in \['active', 'trial'\]/,
  },
  {
    id: 5,
    name: 'Role Escalation via Invite Claim',
    targetPath: '/tenants/tenant-a/members/u2',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    guardPattern: /get\(\/databases\/\$\(database\)\/documents\/invites\/\$\(incoming\(\)\.inviteId\)\)\.data\.role == incoming\(\)\.role/,
  },
  {
    id: 6,
    name: 'Orphaned Invite Claim (Non-Atomic)',
    targetPath: '/tenants/tenant-a/members/u2',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    guardPattern: /getAfter\(\/databases\/\$\(database\)\/documents\/invites\/\$\(incoming\(\)\.inviteId\)\)\.data\.status == 'accepted'/,
  },
  {
    id: 7,
    name: 'Email Spoofing Attack (Unverified Admin Email)',
    targetPath: '/tenants/tenant-a',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
    guardPattern: /function isVerified\(\) \{\s*return isSignedIn\(\) && request\.auth\.token\.email_verified == true;/,
  },
  {
    id: 8,
    name: 'Manager Subscription Tampering on /tenants/{tenantId}',
    targetPath: '/tenants/tenant-a',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    guardPattern: /affectedKeys\(\)\.hasOnly\(\['name', 'city', 'phone', 'updatedAt'\]\)/,
  },
  {
    id: 9,
    name: 'ID Poisoning / DoW on File ID',
    targetPath: '/tenants/tenant-a/files/poisoned-id',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    guardPattern: /function isValidId\(id\) \{\s*return id is string && id\.size\(\) >= 1 && id\.size\(\) <= 128/,
  },
  {
    id: 10,
    name: 'PII Blanket Read on /users/{userId}',
    targetPath: '/users/victim-uid',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
    guardPattern: /match \/users\/\{userId\}[\s\S]*allow get: if isValidId\(userId\) && \(isOwner\(userId\) \|\| isSuperAdmin\(\)\)/,
  },
  {
    id: 11,
    name: 'Unscoped List Scraping on /user_memberships',
    targetPath: '/user_memberships',
    operation: 'list',
    expected: 'PERMISSION_DENIED',
    guardPattern: /match \/user_memberships\/\{membershipKey\}[\s\S]*allow list: if isSuperAdmin\(\) \|\| \(\s*isSignedIn\(\) && resource\.data\.uid == request\.auth\.uid/,
  },
  {
    id: 12,
    name: 'Audit Log Tampering',
    targetPath: '/platform_audit_logs/log-1',
    operation: 'delete',
    expected: 'PERMISSION_DENIED',
    guardPattern: /match \/platform_audit_logs\/\{logId\}[\s\S]*allow update, delete: if false;/,
  },
];

export function verifyRulesAgainstSpec(rulesFilePath: string): { passed: number; failed: string[] } {
  const rulesText = fs.readFileSync(path.resolve(rulesFilePath), 'utf-8');
  const failed: string[] = [];
  for (const tc of DIRTY_DOZEN_CASES) {
    if (!tc.guardPattern.test(rulesText)) {
      failed.push(`#${tc.id} ${tc.name}`);
    }
  }
  return { passed: DIRTY_DOZEN_CASES.length - failed.length, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || 'firestore.rules';
  const res = verifyRulesAgainstSpec(target);
  console.log(`Security TDD check on ${target}: ${res.passed}/${DIRTY_DOZEN_CASES.length} passed`);
  if (res.failed.length) {
    console.error('Failed checks:', res.failed);
    process.exit(1);
  }
}
