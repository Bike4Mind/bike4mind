/**
 * Refresh this far ahead of expiry. Access tokens live 30 minutes
 * (`ACCESS_TOKEN_TTL_SECONDS`), and a later task mints WebSocket connect tickets from the
 * live token, so an expiry reached mid-session breaks a stream rather than merely costing
 * one retried request. Refreshing early is what keeps the token continuously valid; a lazy
 * refresh-on-401 cannot, because a socket already open never sees a 401.
 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Never schedule tighter than this, so a clock skew or a past expiry cannot spin the timer. */
export const MIN_REFRESH_DELAY_MS = 5_000;

/** Node's setTimeout silently fires immediately past this; clamp instead. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Delay until the next proactive refresh. An unparseable or already-elapsed expiry collapses
 * to {@link MIN_REFRESH_DELAY_MS} - refresh promptly, but still on a timer rather than in a
 * tight loop.
 */
export function msUntilProactiveRefresh(expiresAt: string, now: number): number {
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry)) return MIN_REFRESH_DELAY_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_REFRESH_DELAY_MS, expiry - REFRESH_SKEW_MS - now));
}

const RETRY_BASE_MS = 30_000;
const RETRY_CEILING_MS = 5 * 60 * 1000;

/**
 * Backoff after a refresh attempt failed transiently (network down, backend 5xx). Bounded by
 * {@link RETRY_CEILING_MS} so a machine waking from sleep re-establishes promptly.
 * `attempt` is 1-based.
 */
export function msUntilRefreshRetry(attempt: number): number {
  return Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}
