import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HelpAccessLevel } from '@bike4mind/scripts/help/types';

/**
 * These assertions guard an access-control boundary, not a convenience.
 *
 * Admin help articles are no longer bundled into public/, so an admin article's body is only
 * reachable through the authenticated route. Two properties keep that sound on the client, and
 * neither is observable from any other test in the suite (HelpContent.media.test.tsx mocks this
 * hook wholesale):
 *
 *   1. Only a public entry may be requested from the unauthenticated static path. If the branch
 *      were written as `accessLevel === 'admin'`, a future HelpAccessLevel value would be fetched
 *      from /help-content/ - which is exactly the exposure the split closes.
 *   2. The react-query key is identity-scoped. Without it, one identity's fetched admin body is
 *      served out of cache to the next identity in the same tab for the whole 30 minute gcTime.
 */

const useHelpIndexMock = vi.hoisted(() => vi.fn());
vi.mock('./useHelpIndex', () => ({ useHelpIndex: useHelpIndexMock }));

import { useHelpContent } from './useHelpContent';
import { useAccessToken } from './useAccessToken';

const ARTICLE = '---\ntitle: T\n---\n\n# Body\n';

const entry = (slug: string, accessLevel: HelpAccessLevel) => ({
  slug,
  title: slug,
  description: '',
  tags: [],
  headings: [],
  filePath: `${slug}.md`,
  accessLevel,
});

// A fresh client per render, so a cache hit can only come from the key itself.
const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

let fetchMock: ReturnType<typeof vi.fn>;

const lastRequest = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1];

describe('useHelpContent access routing', () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, statusText: 'OK', text: async () => ARTICLE });
    vi.stubGlobal('fetch', fetchMock);
    useHelpIndexMock.mockReturnValue({
      data: {
        entries: [entry('features/overview', 'public'), entry('admin/overview', 'admin')],
        categories: [],
        version: 'v',
      },
    });
    useAccessToken.setState({ accessToken: 'token-a' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAccessToken.setState({ accessToken: null });
  });

  it('fetches a public article from the static path with no Authorization header', async () => {
    const { result } = renderHook(() => useHelpContent('features/overview'), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());

    const [url, init] = lastRequest();
    expect(url).toBe('/help-content/features/overview.md');
    expect(init?.headers?.Authorization).toBeUndefined();
    // Frontmatter is still stripped for both paths.
    expect(result.current.data).toBe('# Body\n');
  });

  it('fetches an admin article from the authenticated route with a Bearer token', async () => {
    const { result } = renderHook(() => useHelpContent('admin/overview'), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());

    const [url, init] = lastRequest();
    expect(url).toBe(`/api/help/content?path=${encodeURIComponent('admin/overview.md')}`);
    expect(init?.headers?.Authorization).toBe('Bearer token-a');
    expect(init?.credentials).toBe('include');
  });

  it('never requests an admin article from the unauthenticated static path', async () => {
    const { result } = renderHook(() => useHelpContent('admin/overview'), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());

    const staticRequests = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/help-content/'));
    expect(staticRequests).toEqual([]);
  });

  it('routes an unrecognised access level through the authenticated route, not the static path', async () => {
    // Fail-closed: a value added to HelpAccessLevel later lands in the admin-only root, so a
    // client that asked the static path for it would be asking for a file that is not there.
    useHelpIndexMock.mockReturnValue({
      data: {
        entries: [{ ...entry('admin/future', 'admin'), accessLevel: 'internal' as HelpAccessLevel }],
        categories: [],
        version: 'v',
      },
    });

    const { result } = renderHook(() => useHelpContent('admin/future'), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(String(lastRequest()[0])).toContain('/api/help/content?path=');
  });
});

describe('useHelpContent identity scoping', () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, statusText: 'OK', text: async () => ARTICLE });
    vi.stubGlobal('fetch', fetchMock);
    useHelpIndexMock.mockReturnValue({
      data: { entries: [entry('admin/overview', 'admin')], categories: [], version: 'v' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAccessToken.setState({ accessToken: null });
  });

  it('refetches for a different identity instead of serving the first identity from cache', async () => {
    // One shared client across both renders: this is the cross-identity cache-reuse scenario.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sharedWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    useAccessToken.setState({ accessToken: 'token-a' });
    const first = renderHook(() => useHelpContent('admin/overview'), { wrapper: sharedWrapper });
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastRequest()[1]?.headers?.Authorization).toBe('Bearer token-a');

    first.unmount();

    useAccessToken.setState({ accessToken: 'token-b' });
    const second = renderHook(() => useHelpContent('admin/overview'), { wrapper: sharedWrapper });
    await waitFor(() => expect(second.result.current.data).toBeDefined());

    // The identity hash is in the query key, so this is a second network request under the new
    // token - not the first identity's cached body.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastRequest()[1]?.headers?.Authorization).toBe('Bearer token-b');
  });

  it('does not refetch a public article when the access token rotates', async () => {
    // Public articles are identity-independent static assets, so a silent token refresh must not
    // invalidate them. Only the admin path is identity-scoped.
    useHelpIndexMock.mockReturnValue({
      data: { entries: [entry('features/overview', 'public')], categories: [], version: 'v' },
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sharedWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    useAccessToken.setState({ accessToken: 'token-a' });
    const first = renderHook(() => useHelpContent('features/overview'), { wrapper: sharedWrapper });
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.unmount();

    useAccessToken.setState({ accessToken: 'token-b' });
    const second = renderHook(() => useHelpContent('features/overview'), { wrapper: sharedWrapper });
    await waitFor(() => expect(second.result.current.data).toBeDefined());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse an authenticated body for an anonymous reader', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sharedWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    useAccessToken.setState({ accessToken: 'token-a' });
    const authed = renderHook(() => useHelpContent('admin/overview'), { wrapper: sharedWrapper });
    await waitFor(() => expect(authed.result.current.data).toBeDefined());
    authed.unmount();

    useAccessToken.setState({ accessToken: null });
    const anon = renderHook(() => useHelpContent('admin/overview'), { wrapper: sharedWrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // Server-side auth is what actually denies this reader; the point here is only that the
    // client cache does not hand over the previous identity's body without asking.
    expect(lastRequest()[1]?.headers?.Authorization).toBeUndefined();
    expect(anon.result.current).toBeDefined();
  });
});
