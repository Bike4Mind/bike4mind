import type { Logger } from '@bike4mind/observability';
import { SIDE_APP_MINT_OUR_FAULT_EVENT } from '@bike4mind/server-utils/auth/sideAppMintEvent';
import { classifySideAppRefusal, recordSideAppRefusal } from '@bike4mind/server-utils/auth/sideAppRefusal';

// Route and client can come from request input, so anything that could forge a log line or bloat it
// is stripped. A value with nothing left logs as `unknown`. Only the route keeps `[]`, for templates
// like `/api/agents/[id]`.
function sanitize(value: unknown, disallowed = /[^A-Za-z0-9._:/-]/g): string {
  const clean = typeof value === 'string' ? value.replace(disallowed, '').slice(0, 128) : '';
  return clean || 'unknown';
}

/**
 * Emit one greppable `[OAUTH_ERROR] route=... client=... error=... status=...` warn line for an OAuth
 * error response, so failures can be counted per client. Never pass error_description,
 * request bodies or credentials: only these four fields are logged. Never throws.
 */
export function logOAuthError(
  logger: Pick<Logger, 'warn'> | undefined,
  { route, clientId, error, status }: { route: string; clientId: unknown; error: string; status: number }
): void {
  try {
    logger?.warn(
      `[OAUTH_ERROR] route=${sanitize(route, /[^A-Za-z0-9._:/[\]-]/g)} client=${sanitize(clientId)} error=${sanitize(error)} status=${status}`
    );
  } catch {
    // Logging must never turn an error response into a 500.
  }
}

/**
 * `logOAuthError` plus a queryable per-app record. Pass `verified` only after the client secret has
 * been checked; before that the id is a claim and only an hourly counter is bumped.
 */
export function logAndRecordSideAppMintRefusal(
  logger: Pick<Logger, 'warn'> | undefined,
  input: {
    route: string;
    clientId: unknown;
    error: string;
    /** Stored reason when it differs from the wire error, so the record can say who was at fault. */
    recordAs?: string;
    status: number;
    verified: boolean;
    userId?: string;
  }
): void {
  logOAuthError(logger, input);
  const reason = input.recordAs ?? input.error;
  if (classifySideAppRefusal(reason) === 'our_fault') {
    try {
      logger?.warn(SIDE_APP_MINT_OUR_FAULT_EVENT, { route: sanitize(input.route), status: input.status });
    } catch {
      // Logging must never turn an error response into a 500.
    }
  }
  recordSideAppRefusal({
    verified: input.verified,
    clientId: typeof input.clientId === 'string' ? input.clientId : undefined,
    stage: 'mint',
    reason,
    status: input.status,
    userId: input.userId,
  });
}
