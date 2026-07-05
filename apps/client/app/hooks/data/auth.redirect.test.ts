/**
 * Open-redirect regression guard for the OAuth-callback navigation.
 *
 * useAuthCallback navigates to a user-controlled `redirectTo` after a successful
 * OAuth callback. This asserts it routes through `sanitizeRedirectTo`/`applyRedirect`
 * (the real helper, not mocked) so an unsafe value falls back to /new instead of
 * becoming an open redirect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const pushMock = vi.fn();
const replaceMock = vi.fn();
let searchValue: Record<string, unknown> = {};
let queryData: { accessToken: string; refreshToken: string } | undefined;

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: pushMock, replace: replaceMock } }),
  useSearch: () => searchValue,
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: queryData }),
  useMutation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ setCurrentUser: vi.fn() }) }));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: { getState: () => ({ setVerifiedTokens: vi.fn() }) },
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));

import { useAuthCallback } from './auth';

describe('useAuthCallback — redirect sanitization', () => {
  beforeEach(() => {
    pushMock.mockClear();
    replaceMock.mockClear();
    queryData = { accessToken: 'a', refreshToken: 'r' };
  });

  it('navigates to a safe same-origin redirectTo (query preserved)', () => {
    searchValue = { redirectTo: '/admin?tab=files' };
    renderHook(() => useAuthCallback('google', 'code123', undefined));
    expect(pushMock).toHaveBeenCalledWith('/admin?tab=files');
  });

  it.each([
    ['//evil.com', 'protocol-relative'],
    ['https://evil.com', 'absolute URL'],
    ['/\\evil.com', 'backslash host'],
    ['javascript:alert(1)', 'javascript: scheme'],
  ])('falls back to /new for unsafe redirectTo %s (%s)', unsafe => {
    searchValue = { redirectTo: unsafe };
    renderHook(() => useAuthCallback('google', 'code123', undefined));
    expect(pushMock).toHaveBeenCalledWith('/new');
  });

  it('falls back to /new when redirectTo is absent', () => {
    searchValue = {};
    renderHook(() => useAuthCallback('google', 'code123', undefined));
    expect(pushMock).toHaveBeenCalledWith('/new');
  });
});
