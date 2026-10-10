import { getWorkspaceSurface, WORKSPACE_SURFACES, type WorkspaceSurface } from '@bike4mind/common';
import type { PremiumRouteDescriptor } from '@client/app/premiumContract';

type HostingRoute = Pick<PremiumRouteDescriptor, 'path' | 'appShell' | 'hostsWorkspace'>;

const segments = (path: string) => path.split('/').filter(Boolean);

/** Whether `pathname` is `routePath`, a `$param` segment standing for any one segment. */
export function matchesRoutePath(pathname: string, routePath: string): boolean {
  const actual = segments(pathname);
  const pattern = segments(routePath);
  return (
    actual.length === pattern.length &&
    pattern.every((segment, index) => (segment.startsWith('$') && segment.length > 1) || segment === actual[index])
  );
}

/**
 * The workspace whose conversation list the notebook sidebar draws at `pathname`: the registered
 * workspace whose own route this is, or the one an app-shell premium route matching it names in
 * `hostsWorkspace`. Null elsewhere, including the main notebook list's routes and a route naming a
 * workspace this repo does not register.
 */
export function hostedWorkspaceAt(pathname: string, routes: readonly HostingRoute[]): string | null {
  const own = WORKSPACE_SURFACES.find(surface => surface.id !== null && surface.routePrefix === pathname);
  if (own?.id) return own.id;
  for (const route of routes) {
    if (!route.appShell || !route.hostsWorkspace || !matchesRoutePath(pathname, route.path)) continue;
    const hosted = getWorkspaceSurface(route.hostsWorkspace);
    if (hosted?.id) return hosted.id;
  }
  return null;
}

/**
 * Where to open `sessionId`, a session in `surface`, from `pathname`. On an app-shell premium route
 * that hosts that workspace (see `hostedWorkspaceAt`), the same route with the query
 * `surface.sessionHref` carries, so the user stays on the page they were using; elsewhere, or when
 * the link carries the id in its path rather than its query, the link itself.
 */
export function workspaceSessionHref(
  surface: WorkspaceSurface,
  sessionId: string,
  pathname: string,
  routes: readonly HostingRoute[]
): string {
  const href = surface.sessionHref(sessionId);
  if (surface.id === null || hostedWorkspaceAt(pathname, routes) !== surface.id) return href;
  // The workspace's own route is already what its registry link opens; a presented link may
  // deliberately point elsewhere, so it is not rewritten onto that route.
  if (getWorkspaceSurface(surface.id)?.routePrefix === pathname) return href;
  const queryAt = href.indexOf('?');
  if (queryAt < 0 || href.slice(0, queryAt).includes(encodeURIComponent(sessionId))) return href;
  return `${pathname}${href.slice(queryAt)}`;
}
