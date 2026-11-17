// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { RouterProvider } from '@tanstack/react-router';
import { getThemeConfig } from '@client/app/utils/themes';

// router.tsx's page beacon reports each resolve; the visit beacon (left real) is the request that
// goes out while router.tsx loads.
vi.mock('../utils/pageBeacon', () => ({ startPageBeacon: vi.fn(), beaconPage: vi.fn() }));
vi.mock('../hooks/useGetLogo', () => ({ default: () => '/logo.png' }));
vi.mock('next/image', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });

/**
 * A full page load of an email link: set the address, then load the app's real router.tsx (whose
 * module-load code runs against that address) and render it on its own browser history.
 */
const openLink = async (href: string) => {
  window.history.replaceState(null, '', href);
  vi.resetModules();
  const { router } = await import('../router');
  const { api } = await import('@client/app/contexts/ApiContext');
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <RouterProvider router={router} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return { router, api };
};

// Each test loads router.tsx afresh (its module-load code is what is under test); the first load is slow.
const LOAD_TIMEOUT_MS = 30_000;

describe('email links that carry a token', () => {
  // The address the browser shows at the moment each request leaves (its Referer).
  let addressAtRequest: { what: string; href: string }[];
  let verifyPost: ReturnType<typeof vi.fn>;
  let unsubscribeGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    addressAtRequest = [];
    verifyPost = vi.fn(async () => ({ data: {} }));
    unsubscribeGet = vi.fn(async () => ({
      data: {
        email: 'reader@example.com',
        preferences: { unsubscribedCategories: [], globalUnsubscribe: false },
        categories: [],
      },
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      addressAtRequest.push({ what: `fetch ${String(input)}`, href: window.location.href });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(function () {
      addressAtRequest.push({ what: 'xhr', href: window.location.href });
    });
    vi.doMock('@client/app/contexts/ApiContext', async importOriginal => {
      const actual = await importOriginal<typeof import('@client/app/contexts/ApiContext')>();
      const post = (url: string, body: unknown) => {
        addressAtRequest.push({ what: `post ${url}`, href: window.location.href });
        return verifyPost(url, body);
      };
      const get = (url: string, config: unknown) => {
        addressAtRequest.push({ what: `get ${url}`, href: window.location.href });
        return unsubscribeGet(url, config);
      };
      return { ...actual, api: Object.assign(Object.create(actual.api), { post, get }) };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@client/app/contexts/ApiContext');
    window.history.replaceState(null, '', '/');
  });

  const cases = [
    ['/verify-email', '/api/email/verify'],
    ['/verify-change', '/api/email/verify-change'],
  ] as const;

  it.each(cases)(
    '%s verifies a #token= link; no request and no later address carries it',
    async (path, endpoint) => {
      const token = `frag-${path.slice(1)}`;
      const { router } = await openLink(`${path}#token=${token}`);

      await waitFor(() => expect(verifyPost).toHaveBeenCalledWith(endpoint, { token }));
      await router.load();
      expect(addressAtRequest.some(r => r.what.startsWith('fetch'))).toBe(true);
      expect(addressAtRequest.filter(r => r.href.includes('token'))).toEqual([]);
      expect(window.location.href).not.toContain('token');
      expect(router.state.location.href).not.toContain('token');
    },
    LOAD_TIMEOUT_MS
  );

  it.each(cases)(
    '%s still verifies an older ?token= link, taking it off the address before the first request',
    async (path, endpoint) => {
      const token = `query-${path.slice(1)}`;
      const { router } = await openLink(`${path}?token=${token}&n=42`);

      await waitFor(() => expect(verifyPost).toHaveBeenCalledWith(endpoint, { token }));
      await router.load();
      expect(addressAtRequest.some(r => r.what.startsWith('fetch'))).toBe(true);
      expect(addressAtRequest.filter(r => r.href.includes('token'))).toEqual([]);
      expect(window.location.href).not.toContain('token');
      expect(router.state.location.href).not.toContain('token');
    },
    LOAD_TIMEOUT_MS
  );

  it.each([
    ['a #token= link', '/email/unsubscribe#token=frag-unsub', 'frag-unsub'],
    ['an older ?token= link', '/email/unsubscribe?token=query-unsub&n=42', 'query-unsub'],
  ])(
    '/email/unsubscribe loads preferences from %s with the token in a header; no request and no later address carries it',
    async (_form, href, token) => {
      const { router } = await openLink(href);

      await waitFor(() =>
        expect(unsubscribeGet).toHaveBeenCalledWith('/api/email/unsubscribe', {
          headers: { 'x-unsubscribe-token': token },
        })
      );
      await router.load();
      expect(addressAtRequest.some(r => r.what.startsWith('fetch'))).toBe(true);
      expect(addressAtRequest.filter(r => r.href.includes('token'))).toEqual([]);
      expect(window.location.href).not.toContain('token');
      expect(router.state.location.href).not.toContain('token');
    },
    LOAD_TIMEOUT_MS
  );
});
