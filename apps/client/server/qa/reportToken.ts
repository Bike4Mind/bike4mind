import jwt from 'jsonwebtoken';
import { Config } from '@server/utils/config';

/** Distinct audience so a login JWT (same secret) can never open a report. */
const AUDIENCE = 'qa-report';
/**
 * Distinct typ so the login verifier (server/auth/verifyJwtPayload.ts) rejects a report token
 * outright: it accepts typ-less tokens as legacy access tokens.
 */
const TOKEN_TYPE = 'qa-report';
/** Seconds. */
const TTL_SEC = 3600;

/**
 * Read-only access to one run's report, because a new tab cannot send the Bearer
 * header. Minted by pages/api/admin/qa/runs/[id].ts for admins; checked by
 * pages/api/admin/qa/report/[runId]/[token]/[...path].ts. Same pattern as
 * server/services/publish/draftUploadUrl.ts.
 */
export function signQaReportToken(runId: string): string {
  return jwt.sign({ runId, typ: TOKEN_TYPE }, Config.JWT_SECRET, {
    algorithm: 'HS256',
    audience: AUDIENCE,
    expiresIn: TTL_SEC,
  });
}

export function verifyQaReportToken(token: string): { runId: string } | null {
  try {
    const claims = jwt.verify(token, Config.JWT_SECRET, { algorithms: ['HS256'], audience: AUDIENCE });
    if (typeof claims !== 'object' || claims.typ !== TOKEN_TYPE || typeof claims.runId !== 'string') return null;
    return { runId: claims.runId };
  } catch {
    return null;
  }
}
