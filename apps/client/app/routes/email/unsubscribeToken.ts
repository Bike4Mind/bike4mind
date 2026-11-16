/**
 * Emailed unsubscribe links carry their token as `/email/unsubscribe#token=...` (built in
 * apps/workers/src/queueHandlers/emailBatch.ts). The fragment never reaches a server, so the token stays
 * out of edge and access logs; the page sends it to pages/api/email/unsubscribe.ts in a header.
 * Emails sent before the fragment form carry `?token=`; those stay accepted, since an already-sent
 * unsubscribe link must keep working.
 */
const TOKEN_PARAM = 'token';

let capturedToken: string | undefined;

/**
 * Moves the link's token out of the address into this module, so no later navigation, Referer or
 * history entry carries it. Runs in the route's beforeLoad, before the page renders.
 */
export function captureUnsubscribeToken(): void {
  const search = new URLSearchParams(window.location.search);
  const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get(TOKEN_PARAM);
  const queryToken = search.get(TOKEN_PARAM);
  const token = fragmentToken || queryToken;
  if (!token) return;

  capturedToken = token;
  search.delete(TOKEN_PARAM);
  const query = search.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

export function getCapturedUnsubscribeToken(): string | undefined {
  return capturedToken;
}
