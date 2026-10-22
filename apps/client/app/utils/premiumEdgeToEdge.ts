import type { PremiumRouteDescriptor } from '@client/app/premiumContract';

/** The paths of the premium routes that opted out of the notebook content gutter (`edgeToEdge`). */
export function edgeToEdgePaths(routes: ReadonlyArray<Pick<PremiumRouteDescriptor, 'path' | 'edgeToEdge'>>): string[] {
  return routes.filter(route => route.edgeToEdge).map(route => route.path);
}

/** Whether `pathname` is one of `paths` or a sub-path of one (`/foo/bar` under `/foo`, never `/foobar`). */
export function isEdgeToEdgePath(pathname: string, paths: readonly string[]): boolean {
  return paths.some(path => pathname === path || pathname.startsWith(`${path}/`));
}
