import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { adminRoute, router } from './router';

// A contributed admin page, as a premium package would declare it.
vi.mock('./premium-generated/premiumRoutes.generated', () => ({
  premiumRoutes: [
    {
      path: '/admin/ext/example',
      lazyImport: () => Promise.resolve({ default: () => <div data-testid="contributed-body">body</div> }),
      adminPage: { section: 'platform', label: 'Example page' },
    },
  ],
}));

// Records the pages the router hands the admin layout, so the wiring is checked without its providers.
const layoutProps = vi.hoisted(() => ({ adminPages: undefined as unknown }));
vi.mock('./components/admin/AdminLayout', () => ({
  AdminLayoutRoute: (props: { adminPages?: unknown }) => {
    layoutProps.adminPages = props.adminPages;
    return <div data-testid="admin-layout-stub" />;
  },
}));

// router.tsx runs these at import time; the other router tests stub them the same way.
vi.mock('./utils/consentGuard', () => ({ enforceConsentRedirect: async () => undefined }));
vi.mock('./utils/pageBeacon', () => ({ startPageBeacon: vi.fn(), beaconPage: vi.fn() }));

const theme = extendTheme({ ...getThemeConfig() });
const PAGE_PATH = '/admin/ext/example';

describe('a contributed admin page route', () => {
  const matched = () => router.getMatchedRoutes(PAGE_PATH);

  it('mounts under the admin layout route, beside the console', () => {
    const chain = matched();
    const page = chain[chain.length - 1];
    const layout = adminRoute.options.getParentRoute();

    expect(page.fullPath).toBe(PAGE_PATH);
    expect(page.options.getParentRoute()).toBe(layout);
    expect(page.parentRoute).toBe(layout);
    expect(layout.id).toBe('/admin-layout');
    expect(page.id).toBe('/admin-layout/admin/ext/example');
  });

  it('is registered in the route tree under that id', () => {
    expect(router.routesById['/admin-layout/admin/ext/example']?.fullPath).toBe(PAGE_PATH);
  });

  it('hands the contributed pages to the admin layout', () => {
    const layout = adminRoute.options.getParentRoute();
    const Layout = layout.options.component as React.ComponentType;

    render(<Layout />);

    expect(layoutProps.adminPages).toEqual([
      expect.objectContaining({ path: PAGE_PATH, adminPage: { section: 'platform', label: 'Example page' } }),
    ]);
  });

  it('renders the lazy page inside the shared admin page frame', async () => {
    const chain = matched();
    const Component = chain[chain.length - 1].options.component as React.ComponentType;

    render(
      <CssVarsProvider theme={theme}>
        <Suspense fallback={null}>
          <Component />
        </Suspense>
      </CssVarsProvider>
    );

    const frame = await screen.findByTestId('admin-contributed-page');
    expect(frame).toContainElement(await screen.findByTestId('contributed-body'));
  });
});
