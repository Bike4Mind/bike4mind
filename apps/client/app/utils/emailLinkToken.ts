/**
 * Email verification links (/verify-email, /verify-change) carry their single-use token in the URL
 * fragment (`#token=`, built by generateVerificationLink in packages/server-utils), which the browser
 * never sends to a server, so no access log, edge log or Referer header sees it. Links sent before the
 * fragment form keep working: they carry it as `?token=`, read when the fragment has none.
 *
 * The route's beforeLoad calls takeEmailLinkToken, which moves the token out of the address into this
 * module before the page renders, so the URL no longer holds it when the page's verify request (or any
 * later request) fires. The page reads it back with getEmailLinkToken. Same approach as the OAuth
 * callback (utils/authParams.ts) and the persona redeem code (routes/personas/personaRedeemCode.ts).
 */
const takenTokens = new Map<string, string>();

/**
 * Take the token from the current address (fragment first, then query), drop it from both, keep every
 * other param, and remember it under `routePath`. A re-run with nothing left in the address returns the
 * token already taken for that route.
 */
export function takeEmailLinkToken(routePath: string): string | undefined {
  const { pathname, search, hash } = window.location;
  const fragment = new URLSearchParams(hash.slice(1));
  const query = new URLSearchParams(search);
  if (!fragment.has('token') && !query.has('token')) return takenTokens.get(routePath);

  const token = fragment.get('token') || query.get('token');
  if (token) takenTokens.set(routePath, token);

  fragment.delete('token');
  query.delete('token');
  const nextSearch = query.toString();
  const nextHash = fragment.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash ? `#${nextHash}` : ''}`
  );
  return takenTokens.get(routePath);
}

/** The token takeEmailLinkToken moved out of the address for `routePath`, if any. */
export function getEmailLinkToken(routePath: string): string | undefined {
  return takenTokens.get(routePath);
}
