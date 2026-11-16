// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { getThemeConfig } from '@client/app/utils/themes';
import { api } from '@client/app/contexts/ApiContext';

// Same isolation as router.test.tsx: router.tsx starts the page beacon on import, and the consent guard
// bootstraps a session over the network.
vi.mock('../utils/consentGuard', () => ({ enforceConsentRedirect: async () => undefined }));
vi.mock('../utils/pageBeacon', () => ({ startPageBeacon: vi.fn(), beaconPage: vi.fn() }));
vi.mock('../hooks/useGetLogo', () => ({ default: () => '/logo.png' }));
vi.mock('next/image', () => ({ default: () => null }));

const { verifyEmailRoute, verifyEmailChangeRoute } = await import('../router');

const appTheme = extendTheme({ ...getThemeConfig() });

/** Mounts the app's real route (its beforeLoad and page) at the address an email link opens. */
const openLink = (route: typeof verifyEmailRoute | typeof verifyEmailChangeRoute, href: string) => {
  window.history.replaceState(null, '', href);
  const root = createRootRoute({ component: () => <Outlet /> });
  const probe = createRoute({
    getParentRoute: () => root,
    path: route.options.path,
    beforeLoad: route.options.beforeLoad,
    component: route.options.component,
  });
  const router = createRouter({
    routeTree: root.addChildren([probe]),
    history: createMemoryHistory({ initialEntries: [href] }),
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <RouterProvider router={router} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

describe('email verification links', () => {
  // The address the browser shows at the moment each verify request leaves.
  let addressAtRequest: string[];

  beforeEach(() => {
    addressAtRequest = [];
    vi.spyOn(api, 'post').mockImplementation(async () => {
      addressAtRequest.push(window.location.href);
      return { data: {} };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it.each([
    ['/verify-email', verifyEmailRoute, '/api/email/verify'],
    ['/verify-change', verifyEmailChangeRoute, '/api/email/verify-change'],
  ] as const)(
    '%s verifies a #token= link with the token already gone from the address',
    async (path, route, endpoint) => {
      const token = `frag-${path.slice(1)}`;
      openLink(route, `${path}#token=${token}`);

      await waitFor(() => expect(api.post).toHaveBeenCalledWith(endpoint, { token }));
      expect(addressAtRequest).toHaveLength(1);
      expect(addressAtRequest[0]).not.toContain(token);
      expect(addressAtRequest[0]).not.toContain('token=');
    }
  );

  it.each([
    ['/verify-email', verifyEmailRoute, '/api/email/verify'],
    ['/verify-change', verifyEmailChangeRoute, '/api/email/verify-change'],
  ] as const)(
    '%s still verifies an older ?token= link, stripping it before the request',
    async (path, route, endpoint) => {
      const token = `query-${path.slice(1)}`;
      openLink(route, `${path}?token=${token}`);

      await waitFor(() => expect(api.post).toHaveBeenCalledWith(endpoint, { token }));
      expect(addressAtRequest).toHaveLength(1);
      expect(addressAtRequest[0]).not.toContain(token);
      expect(addressAtRequest[0]).not.toContain('token=');
    }
  );
});
