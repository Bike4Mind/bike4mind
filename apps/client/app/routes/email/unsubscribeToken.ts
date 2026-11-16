/**
 * Emailed unsubscribe links carry their token as `/email/unsubscribe#token=...` (built in
 * apps/workers/src/queueHandlers/emailBatch.ts). The fragment never reaches a server, so the token stays
 * out of edge and access logs; the page sends it to pages/api/email/unsubscribe.ts in a header.
 */
const TOKEN_PARAM = 'token';

/**
 * Emails sent before the fragment form carry `?token=`. Those links keep working until this cutoff
 * (ms since epoch, UTC), then the page treats them as missing a token. Remove the query branch after it.
 */
export const LEGACY_QUERY_TOKEN_CUTOFF_MS = Date.UTC(2027, 1, 16);

let capturedToken: string | undefined;

/**
 * Moves the link's token out of the address into this module, so no later navigation, Referer or
 * history entry carries it. Runs in the route's beforeLoad, before the page renders.
 */
export function captureUnsubscribeToken(now: number = Date.now()): void {
  const search = new URLSearchParams(window.location.search);
  const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get(TOKEN_PARAM);
  const queryToken = search.get(TOKEN_PARAM);
  const hadToken = Boolean(fragmentToken || queryToken);

  capturedToken = fragmentToken || (now < LEGACY_QUERY_TOKEN_CUTOFF_MS ? queryToken : null) || undefined;
  if (!hadToken) return;

  search.delete(TOKEN_PARAM);
  const query = search.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

export function getCapturedUnsubscribeToken(): string | undefined {
  return capturedToken;
}
