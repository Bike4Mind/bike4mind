import { getWorkspaceSurface, WORKSPACE_SURFACES } from '@bike4mind/common';
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
