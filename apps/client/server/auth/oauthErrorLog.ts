import type { Logger } from '@bike4mind/observability';

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
