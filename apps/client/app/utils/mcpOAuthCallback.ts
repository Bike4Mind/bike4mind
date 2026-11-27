import { redirect } from '@tanstack/react-router';
import { useUser } from '@client/app/contexts/UserContext';
import { buildRedirectTo } from '@client/app/utils/authRedirect';
import { bootstrapSession } from '@client/app/utils/sessionBootstrap';

/** Where a custom MCP connector's authorization server returns the browser. Must match the server's `MCP_OAUTH_CALLBACK_PATH`. */
export const MCP_OAUTH_CALLBACK_PATH = '/integrations/mcp-oauth-callback';

let bootSearch: string | null = null;

/**
 * Snapshot the callback's query string exactly as the authorization server sent it. MUST run at module
 * load, before createRouter: the router JSON-parses every search value on its first resolve, so an
 * all-digit `code` would reach the page as a number (see githubLakeCallbackSearch.ts).
 */
export function captureMcpOAuthCallbackSearch(): void {
  if (typeof window === 'undefined') return;
  bootSearch = window.location.pathname === MCP_OAUTH_CALLBACK_PATH ? window.location.search : null;
}

/** The untouched query string when this page load landed on the callback, else null. */
export function getMcpOAuthCallbackBootSearch(): string | null {
  return bootSearch;
}

/** Forget the snapshot once its single-use code has been spent. */
export function clearMcpOAuthCallbackBootSearch(): void {
  bootSearch = null;
}

/**
 * beforeLoad for the callback route, which sits outside layoutRoute and so lacks its session guard. The
 * return is a cold load, so the page's single-use POST would otherwise race the session bootstrap and go
 * out unauthenticated. With no session, send the user to /login and back with the original query.
 */
export async function requireMcpOAuthCallbackSession(location: { pathname: string; searchStr: string }) {
  await bootstrapSession();
  if (useUser.getState().currentUser) return;

  const redirectTo = buildRedirectTo(location.pathname, getMcpOAuthCallbackBootSearch() ?? location.searchStr);
  throw redirect({ to: '/login', search: redirectTo ? { redirectTo } : undefined });
}
