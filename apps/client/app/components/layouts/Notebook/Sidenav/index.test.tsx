import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { WORKSPACE_SURFACES } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * WHICH sidenav the notebook shell shows.
 *
 * The slot used to be a single premium component matched against a hardcoded pathname. It is now
 * a per-route list the overlays declare, and the selection - the entry whose `path` is the current
 * route, or the route prefix of the workspace hosted there, falling back to the shared notebook
 * list - is the whole of what this file decides. The codegen test covers the generated TEXT; this
 * covers the RUNTIME, because a wrong field, a flipped condition or the wrong fallback would pass
 * every assertion over that text.
 */

const { pathname } = vi.hoisted(() => ({ pathname: { current: '/' } }));
const { sidenavs } = vi.hoisted(() => ({
  sidenavs: { current: [] as Array<{ path: string; component: () => JSX.Element }> },
}));
const { routes } = vi.hoisted(() => ({
  routes: { current: [] as Array<{ path: string; appShell?: boolean; hostsWorkspace?: string }> },
}));

vi.mock('@tanstack/react-router', () => ({
  // The component reads through a selector, so the mock has to honour one.
  useLocation: ({ select }: { select: (l: { pathname: string }) => unknown }) => select({ pathname: pathname.current }),
}));

// The generated glue. Mutable through the hoisted ref so each case can declare its own overlays
// without re-importing the component under test.
vi.mock('@client/app/premium-generated/premiumNotebookSidenavs.generated', () => ({
  get premiumNotebookSidenavs() {
    return sidenavs.current;
  },
}));
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({
  get premiumRoutes() {
    return routes.current;
  },
}));

// CombinedNotebooks is loaded through `next/dynamic`; stub the loader so the default body is a
// plain, synchronous component. It is the only dynamic import in this file, so the stub is
// unambiguous - the premium navs come from the mocked glue above, not from here.
vi.mock('next/dynamic', () => ({
  default: () =>
    function CombinedNotebooksStub() {
      return <div data-testid="sidenav-default-body" />;
    },
}));

vi.mock('./Header', () => ({ default: () => <div /> }));
vi.mock('./Footer', () => ({ default: () => <div /> }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsTablet: () => false }));
vi.mock('..', () => ({
  useNotebookLayout: (select: (s: unknown) => unknown) => select({ openSideNav: false, setOpenSideNav: vi.fn() }),
}));

import NotebookSideNav from './index';

const appTheme = extendTheme({ ...getThemeConfig() });

// Found by shape rather than by name, so the hosting cases follow whichever workspace the registry
// carries rather than pinning one overlay's surface into core's tests.
const workspace = WORKSPACE_SURFACES.find(surface => surface.id !== null);
if (!workspace?.id) throw new Error('expected a registered workspace');

function renderAt(
  path: string,
  entries: Array<{ path: string; component: () => JSX.Element }> = sidenavs.current,
  premiumRoutes: Array<{ path: string; appShell?: boolean; hostsWorkspace?: string }> = []
) {
  pathname.current = path;
  sidenavs.current = entries;
  routes.current = premiumRoutes;
  return render(
    <CssVarsProvider theme={appTheme}>
      <NotebookSideNav />
    </CssVarsProvider>
  );
}

function overlay(name: string) {
  const OverlaySidenav = () => <div data-testid={`overlay-${name}`} />;
  OverlaySidenav.displayName = `OverlaySidenav(${name})`;
  return OverlaySidenav;
}
const TWO = [
  { path: '/alpha', component: overlay('alpha') },
  { path: '/beta', component: overlay('beta') },
];

const defaultBody = () => screen.queryByTestId('sidenav-default-body');

describe('which sidenav body the notebook shell renders', () => {
  it('renders the overlay that claims the current route', () => {
    renderAt('/alpha', TWO);
    expect(screen.queryByTestId('overlay-alpha')).toBeTruthy();
    expect(defaultBody()).toBeNull();
  });

  it('renders the SECOND overlay on its own route - the case the single slot could not serve', () => {
    renderAt('/beta', TWO);
    expect(screen.queryByTestId('overlay-beta')).toBeTruthy();
    expect(screen.queryByTestId('overlay-alpha')).toBeNull();
  });

  it('falls back to the shared notebook list on a route no overlay claims', () => {
    renderAt('/other', TWO);
    expect(defaultBody()).toBeTruthy();
    expect(screen.queryByTestId('overlay-alpha')).toBeNull();
    expect(screen.queryByTestId('overlay-beta')).toBeNull();
  });

  it('falls back on the home route, which no overlay may claim', () => {
    renderAt('/', TWO);
    expect(defaultBody()).toBeTruthy();
  });

  it('falls back everywhere with no overlays installed - the open-core fork', () => {
    renderAt('/alpha', []);
    expect(defaultBody()).toBeTruthy();
  });

  it('matches the route exactly, so an overlay cannot claim a path that merely starts with its own', () => {
    // `/alphabet` is not `/alpha`. This also pins today's behaviour on an overlay's SUB-routes:
    // they get the shared list, exactly as they did when the match was a hardcoded equality.
    renderAt('/alphabet', TWO);
    expect(defaultBody()).toBeTruthy();
    expect(screen.queryByTestId('overlay-alpha')).toBeNull();
  });
});

/**
 * A registered workspace's list follows the workspace: it draws on the workspace's own route and on
 * any app-shell premium route declaring it hosts that workspace - without core naming either route.
 */
describe('a hosted workspace keeps its own list', () => {
  const WORKSPACE = [{ path: workspace.routePrefix, component: overlay('workspace') }];
  const HOSTING = [{ path: '/desk', appShell: true, hostsWorkspace: workspace.id ?? undefined }];
  const workspaceList = () => screen.queryByTestId('overlay-workspace');

  it("draws the workspace's list on the workspace's own route", () => {
    renderAt(workspace.routePrefix, WORKSPACE, HOSTING);
    expect(workspaceList()).toBeTruthy();
  });

  it('draws the workspace list on a contributed route that hosts it', () => {
    renderAt('/desk', WORKSPACE, HOSTING);
    expect(workspaceList()).toBeTruthy();
    expect(defaultBody()).toBeNull();
  });

  it('draws the default list on a contributed route that does not host it', () => {
    renderAt('/desk', WORKSPACE, [{ path: '/desk', appShell: true }]);
    expect(defaultBody()).toBeTruthy();
  });

  it('draws the default list on a hosting route when the build carries no workspace list', () => {
    renderAt('/desk', [], HOSTING);
    expect(defaultBody()).toBeTruthy();
  });

  it('leaves an unregistered overlay matched on its own path alone', () => {
    // The hosting route resolves a registered workspace; an overlay that is not that workspace
    // must not be pulled in by it.
    renderAt('/desk', TWO, HOSTING);
    expect(defaultBody()).toBeTruthy();
    expect(screen.queryByTestId('overlay-alpha')).toBeNull();
  });
});

describe('NotebookSideNav landmark', () => {
  it('is a navigation landmark named Sidebar', () => {
    // Unclaimed route, so this is the shared body - the landmark is the shell, not whichever body
    // the selection above picks.
    renderAt('/new', [], []);
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBe(screen.getByTestId('sidenav-container'));
  });
});
