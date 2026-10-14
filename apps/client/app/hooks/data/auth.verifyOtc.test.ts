/**
 * Regression guard: useVerifyOTC must preserve the re-issued `pendingToken` from a failed
 * /api/otc/verify. The server rotates a single-use nonce on every attempt and returns a
 * fresh token; dropping it on the rethrown error stranded users on a VALID code: a wrong
 * attempt followed by the correct code was rejected because the client kept reusing the
 * stale token (its nonce already rotated, so the server rejects with "Invalid code."). See LoginError.pendingToken.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';

const postMock = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: (...args: unknown[]) => postMock(...args) } }));

import { useVerifyOTC } from './auth';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return React.createElement(QueryClientProvider, { client }, children);
};

function makeVerify422(data: Record<string, unknown>): AxiosError {
  const error = new AxiosError('Request failed with status code 422', 'ERR_BAD_REQUEST');
  error.response = { status: 422, statusText: 'Unprocessable Entity', headers: {}, config: {}, data } as AxiosResponse;
  return error;
}

describe('useVerifyOTC — preserves re-issued pendingToken on failure', () => {
  it('surfaces the re-issued pendingToken from a 422 so the caller can retry with the rotated nonce', async () => {
    postMock.mockRejectedValueOnce(
      makeVerify422({ error: 'Invalid code. 4 attempts remaining.', pendingToken: 'REISSUED_TOKEN' })
    );
    const { result } = renderHook(() => useVerifyOTC(), { wrapper });

    await expect(
      result.current.mutateAsync({ email: 'x@test.com', code: '000000', pendingToken: 'ORIGINAL_TOKEN' })
    ).rejects.toMatchObject({
      message: 'Invalid code. 4 attempts remaining.',
      code: 'CLIENT_ERROR_422',
      pendingToken: 'REISSUED_TOKEN',
    });
  });

  it('maps the server error message even when no pendingToken is returned', async () => {
    postMock.mockRejectedValueOnce(makeVerify422({ error: 'Invalid code.' }));
    const { result } = renderHook(() => useVerifyOTC(), { wrapper });

    await expect(
      result.current.mutateAsync({ email: 'x@test.com', code: '000000', pendingToken: 'ORIGINAL_TOKEN' })
    ).rejects.toMatchObject({ message: 'Invalid code.', code: 'CLIENT_ERROR_422' });
  });
});

describe('useVerifyOTC - Retry-After parsing on 429', () => {
  it.each([
    ['30', 30],
    ['0', 0],
    ['   ', undefined],
    [undefined, undefined],
  ])('maps Retry-After %j to retryAfterSeconds %j', async (header, expected) => {
    const error = new AxiosError('Request failed with status code 429', 'ERR_BAD_REQUEST');
    error.response = {
      status: 429,
      statusText: 'Too Many Requests',
      headers: header === undefined ? {} : { 'retry-after': header },
      config: {},
      data: { error: 'Too many attempts.' },
    } as AxiosResponse;
    postMock.mockRejectedValueOnce(error);
    const { result } = renderHook(() => useVerifyOTC(), { wrapper });

    const rejection = await result.current
      .mutateAsync({ email: 'x@test.com', code: '000000', pendingToken: 'T' })
      .catch(e => e);

    expect(rejection).toMatchObject({ code: 'CLIENT_ERROR_429' });
    expect(rejection.retryAfterSeconds).toBe(expected);
  });
});

describe('useVerifyOTC - OAuth source client', () => {
  const setSearch = (search: string) => window.history.replaceState(null, '', `/register${search}`);

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    postMock.mockReset();
  });

  it('sends the client_id of an authorize redirectTo as sourceClientId', async () => {
    setSearch(`?redirectTo=${encodeURIComponent('/oauth/authorize?client_id=b4m_acme_0a1b2c3d&response_type=code')}`);
    postMock.mockResolvedValueOnce({ data: {} });
    const { result } = renderHook(() => useVerifyOTC(), { wrapper });
    await result.current.mutateAsync({ email: 'x@test.com', code: '123456' });
    expect(postMock).toHaveBeenCalledWith('/api/otc/verify', {
      email: 'x@test.com',
      code: '123456',
      sourceClientId: 'b4m_acme_0a1b2c3d',
    });
  });

  it.each([
    ['no redirectTo', ''],
    ['a non-authorize redirectTo', `?redirectTo=${encodeURIComponent('/settings?client_id=x')}`],
    ['an off-site redirectTo', `?redirectTo=${encodeURIComponent('//evil.example.com/oauth/authorize?client_id=x')}`],
  ])('omits sourceClientId with %s', async (_label, search) => {
    setSearch(search);
    postMock.mockResolvedValueOnce({ data: {} });
    const { result } = renderHook(() => useVerifyOTC(), { wrapper });
    await result.current.mutateAsync({ email: 'x@test.com', code: '123456' });
    expect(postMock.mock.calls[0][1]).not.toHaveProperty('sourceClientId');
  });
});
