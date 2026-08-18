import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  adminReturnValidationError,
  ADMIN_SESSION_EXPIRED,
  ADMIN_SESSION_VALIDATION_FAILED,
  useGetIdentify,
} from './user';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn() },
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: vi.fn(),
}));

vi.mock('../useAccessToken', () => ({
  useAccessToken: vi.fn(),
}));

const { useUser } = await import('@client/app/contexts/UserContext');
const { useAccessToken } = await import('../useAccessToken');

describe('useGetIdentify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };

  it('treats persisted initialData as immediately stale so a background refetch fires', async () => {
    const fakeUser = { id: 'u1', name: 'Test', preferences: {} };
    const fakeToken = 'stale-jwt';

    vi.mocked(useUser).mockImplementation((sel: any) => sel({ currentUser: fakeUser }));
    vi.mocked(useAccessToken).mockImplementation((sel: any) => sel({ accessToken: fakeToken }));

    const { result } = renderHook(() => useGetIdentify(), { wrapper });

    // initialData is provided, so the query starts as success
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The data should be the persisted stub (initialData)
    expect(result.current.data?.user).toEqual(fakeUser);

    // Critical assertion: the data must be immediately stale (dataUpdatedAt === 0)
    // so React Query fires a background refetch rather than suppressing the
    // network call for the full staleTime window.
    expect(result.current.isStale).toBe(true);
  });

  it('does not set initialData when the persisted user lacks preferences', () => {
    const fakeUser = { id: 'u1', name: 'Test' };
    const fakeToken = 'some-jwt';

    vi.mocked(useUser).mockImplementation((sel: any) => sel({ currentUser: fakeUser }));
    vi.mocked(useAccessToken).mockImplementation((sel: any) => sel({ accessToken: fakeToken }));

    const { result } = renderHook(() => useGetIdentify(), { wrapper });

    // No initialData -> query starts in pending state, not success
    expect(result.current.data).toBeUndefined();
  });
});

describe('adminReturnValidationError', () => {
  it('returns the force-logout sentinel for an auth rejection (401/403)', () => {
    expect(adminReturnValidationError(401, false)).toBe(ADMIN_SESSION_EXPIRED);
    expect(adminReturnValidationError(403, false)).toBe(ADMIN_SESSION_EXPIRED);
  });

  it('returns a transient, non-sentinel message for a 5xx / other non-OK (must NOT force a logout)', () => {
    // The load-bearing invariant: a 503 from /api/identify surfaces an error but does not
    // equal ADMIN_SESSION_EXPIRED, so onError leaves the session intact. A future refactor
    // normalizing all non-OK to the sentinel would fail here.
    const msg = adminReturnValidationError(500, false);
    expect(msg).toBe(ADMIN_SESSION_VALIDATION_FAILED);
    expect(msg).not.toBe(ADMIN_SESSION_EXPIRED);
    expect(adminReturnValidationError(503, false)).toBe(ADMIN_SESSION_VALIDATION_FAILED);
  });

  it('returns null for an OK response', () => {
    expect(adminReturnValidationError(200, true)).toBeNull();
  });
});
