import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { Request } from 'express';
import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };

export const SUPER_ADMIN_EMAIL = 'nadiraouf16@gmail.com';

const adminApp = getApps().length
  ? getApp()
  : initializeApp({
      projectId: firebaseConfig.projectId,
    });

export const adminAuth = getAuth(adminApp);

export interface VerifiedCloudUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  photoURL: string;
  isSuperAdmin: boolean;
  token: DecodedIdToken;
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }
  const queryToken = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
  if (queryToken) return queryToken;
  return null;
}

export async function verifyCloudRequest(req: Request): Promise<VerifiedCloudUser | null> {
  const rawToken = extractBearerToken(req);
  if (!rawToken) return null;
  try {
    const decoded = await adminAuth.verifyIdToken(rawToken);
    const email = String(decoded.email || '').trim().toLowerCase();
    const emailVerified = Boolean(decoded.email_verified);
    if (!email) return null;
    const displayName = String(decoded.name || email.split('@')[0] || 'مستخدم').trim();
    const photoURL = String(decoded.picture || '').trim();
    const isSuperAdmin = emailVerified && email === SUPER_ADMIN_EMAIL;
    return {
      uid: decoded.uid,
      email,
      emailVerified,
      displayName,
      photoURL,
      isSuperAdmin,
      token: decoded,
    };
  } catch (err) {
    console.warn('[atelier-cloud] Failed to verify Firebase ID token:', (err as Error)?.message || err);
    return null;
  }
}
