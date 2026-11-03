import jwt from 'jsonwebtoken';
import { Config } from '@bike4mind/server-utils/utils/config';

/** Distinct audience so a login JWT (same secret) can never stand in for a preview. */
const AUDIENCE = 'bulk-abuse-preview';
/** Distinct typ so the login verifier (server/auth/verifyJwtPayload.ts) rejects a preview token outright. */
const TOKEN_TYPE = 'bulk-abuse-preview';
/** Seconds. Long enough to read the preview, short enough that a stale one is re-run. */
const TTL_SEC = 15 * 60;

/**
 * Binds a bulk abuse preview to the admin who ran it and to abuseService.bulkAbuseFingerprint of
 * what it showed. Minted by pages/api/admin/abuse/bulk-preview.ts, checked by bulk-execute.ts.
 */
export type BulkAbusePreviewClaims = {
  adminId: string;
  fingerprint: string;
  /** The cohort's upToUserId, so execute re-resolves the same domain users. */
  upToUserId: string | null;
};

export function signBulkAbusePreviewToken(adminId: string, fingerprint: string, upToUserId: string | null): string {
  return jwt.sign({ fingerprint, upToUserId, typ: TOKEN_TYPE }, Config.JWT_SECRET, {
    algorithm: 'HS256',
    audience: AUDIENCE,
    subject: adminId,
    expiresIn: TTL_SEC,
  });
}

export function verifyBulkAbusePreviewToken(token: string): BulkAbusePreviewClaims | null {
  try {
    const claims = jwt.verify(token, Config.JWT_SECRET, { algorithms: ['HS256'], audience: AUDIENCE });
    if (typeof claims !== 'object' || claims.typ !== TOKEN_TYPE) return null;
    if (typeof claims.sub !== 'string' || typeof claims.fingerprint !== 'string') return null;
    const upToUserId = typeof claims.upToUserId === 'string' ? claims.upToUserId : null;
    return { adminId: claims.sub, fingerprint: claims.fingerprint, upToUserId };
  } catch {
    return null;
  }
}
