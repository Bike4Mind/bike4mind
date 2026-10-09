import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * WHICH sidenav the notebook shell shows.
 *
 * The slot used to be a single premium component matched against a hardcoded pathname. It is now
 * a per-route list the overlays declare, and the selection - `find(path === pathname)`, falling
 * back to the shared notebook list - is the whole of what this file decides. The codegen test
 * covers the generated TEXT; this covers the RUNTIME, because a wrong field, a flipped condition
 * or the wrong fallback would pass every assertion over that text.
 */

const { pathname } = vi.hoisted(() => ({ pathname: { current: '/' } }));
const { sidenavs } = vi.hoisted(() => ({
  sidenavs: { current: [] as Array<{ path: string; component: () => JSX.Element }> },
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

function renderAt(path: string, entries: Array<{ path: string; component: () => JSX.Element }> = sidenavs.current) {
  pathname.current = path;
  sidenavs.current = entries;
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
