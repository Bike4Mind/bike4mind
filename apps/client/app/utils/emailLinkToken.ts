/**
 * Email links that land on a page with a token (/verify-email, /verify-change, /email/unsubscribe) carry
 * it in the URL fragment (`#token=`, built by generateVerificationLink in packages/server-utils and by
 * the unsubscribe footer in apps/workers/src/queueHandlers/emailBatch.ts), which the browser never sends
 * to a server, so no access log, edge log or Referer header sees it. Links sent before the fragment form
 * keep working, with no end date: they carry it as `?token=`, read when the fragment has none.
 *
 * captureEmailLinkToken MUST run at module load in router.tsx, before the visit beacon and before
 * createRouter: it moves the token out of the address into this module, so no request the page sends
 * (whose Referer is the full page URL, query included) carries it, and the router never builds a
 * location that holds it and could write it back. It runs once more in TanStackRouterProvider's layout
 * effect: Next's App Router writes the URL it read at boot back into the address on its first commit,
 * which can come after router.tsx loaded. Running it again only clears the address; the token it took
 * stays. The page reads it with getEmailLinkToken. Same idea
 * as the OAuth callback (utils/authParams.ts) and the persona redeem code (routes/personas/personaRedeemCode.ts).
 */
export const VERIFY_EMAIL_PATH = '/verify-email';
export const VERIFY_EMAIL_CHANGE_PATH = '/verify-change';
export const EMAIL_UNSUBSCRIBE_PATH = '/email/unsubscribe';
export type EmailLinkPath = typeof VERIFY_EMAIL_PATH | typeof VERIFY_EMAIL_CHANGE_PATH | typeof EMAIL_UNSUBSCRIBE_PATH;

const EMAIL_LINK_PATHS: readonly string[] = [VERIFY_EMAIL_PATH, VERIFY_EMAIL_CHANGE_PATH, EMAIL_UNSUBSCRIBE_PATH];

let taken: { path: string; token: string } | undefined;

/**
 * When this page load landed on an email link page, take its token from the address (fragment first,
 * then query), drop it from both while keeping every other param, and keep it for the page.
 */
export function captureEmailLinkToken(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  // Routes match case-insensitively, so /Verify-Email/ is the same page.
  const path = (pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname).toLowerCase();
  if (!EMAIL_LINK_PATHS.includes(path)) return;

  const fragment = new URLSearchParams(hash.slice(1));
  const query = new URLSearchParams(search);
  if (!fragment.has('token') && !query.has('token')) return;

  const token = fragment.get('token') || query.get('token');
  if (token) taken = { path, token };

  fragment.delete('token');
  query.delete('token');
  const nextSearch = query.toString();
  const nextHash = fragment.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash ? `#${nextHash}` : ''}`
  );
}

/** The token captureEmailLinkToken took from this page load's address, if it landed on `path`. */
export function getEmailLinkToken(path: EmailLinkPath): string | undefined {
  return taken?.path === path ? taken.token : undefined;
}
