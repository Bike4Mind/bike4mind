import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: vi.fn() }));
vi.mock('@client/app/hooks/useAccessToken', () => ({ useAccessToken: vi.fn() }));

const postMock = vi.fn();
const getMock = vi.fn();
const solveMock = vi.fn();
vi.mock('@client/app/utils/turnstile', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/utils/turnstile')>()),
  getTurnstileToken: (...args: unknown[]) => solveMock(...args),
}));
beforeEach(() => {
  vi.resetAllMocks();
  getMock.mockResolvedValue({ data: { turnstileSiteKey: '' } });
});
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...args: unknown[]) => getMock(...args), post: (...args: unknown[]) => postMock(...args) },
}));

import { useSendOTC } from './auth';
import { TurnstileCancelledError, TurnstileError } from '@client/app/utils/turnstile';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client }, children);
};

function make429(headers: Record<string, unknown>): AxiosError {
  const error = new AxiosError('Request failed with status code 429', 'ERR_BAD_REQUEST');
  error.response = {
    status: 429,
    statusText: 'Too Many Requests',
    headers,
    config: {},
    data: { error: 'Please wait before requesting another code.' },
  } as AxiosResponse;
  return error;
}

describe('useSendOTC - Retry-After parsing on 429', () => {
  it.each([
    ['0', 0],
    [undefined, undefined],
    ['', undefined],
    ['12', 12],
    [12, 12],
    ['   ', undefined],
    [' 7 ', 7],
    ['abc', undefined],
    ['-5', undefined],
  ])('maps Retry-After %j to retryAfterSeconds %j', async (header, expected) => {
    const headers = header === undefined ? {} : { 'retry-after': header };
    postMock.mockRejectedValueOnce(make429(headers));
    const { result } = renderHook(() => useSendOTC(), { wrapper });

    const rejection = await result.current.mutateAsync({ email: 'x@test.com' } as never).catch(e => e);

    expect(rejection).toMatchObject({ code: 'CLIENT_ERROR_429' });
    expect(rejection.retryAfterSeconds).toBe(expected);
  });
});

describe('useSendOTC challenge gate', () => {
  it('sends without loading a challenge when protection is disabled', async () => {
    postMock.mockResolvedValue({ data: { pendingToken: 'pending' } });
    const { result } = renderHook(() => useSendOTC(), { wrapper });
    await expect(result.current.mutateAsync({ email: 'x@test.com' })).resolves.toEqual({ pendingToken: 'pending' });
    expect(solveMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledWith('/api/otc/send', { email: 'x@test.com', turnstileToken: undefined });
  });

  it('solves again for each send and forwards the fresh token', async () => {
    getMock.mockResolvedValue({ data: { turnstileSiteKey: 'site' } });
    solveMock.mockResolvedValueOnce('token-1').mockResolvedValueOnce('token-2');
    postMock.mockResolvedValue({ data: { pendingToken: 'pending' } });
    const { result } = renderHook(() => useSendOTC(), { wrapper });
    await result.current.mutateAsync({ email: 'x@test.com' });
    await result.current.mutateAsync({ email: 'x@test.com' });
    expect(solveMock).toHaveBeenCalledTimes(2);
    expect(solveMock).toHaveBeenLastCalledWith('site', 'otc-send');
    expect(postMock.mock.calls.map(call => call[1].turnstileToken)).toEqual(['token-1', 'token-2']);
  });

  it('does not send when public configuration cannot be read', async () => {
    getMock.mockRejectedValue(new Error('config unavailable'));
    const { result } = renderHook(() => useSendOTC(), { wrapper });
    await expect(result.current.mutateAsync({ email: 'x@test.com' })).rejects.toMatchObject({
      message: 'config unavailable',
    });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('does not send when the challenge fails', async () => {
    getMock.mockResolvedValue({ data: { turnstileSiteKey: 'site' } });
    solveMock.mockRejectedValue(new Error('turnstile-error'));
    postMock.mockResolvedValue({ data: undefined });
    const { result } = renderHook(() => useSendOTC(), { wrapper });
    await expect(result.current.mutateAsync({ email: 'x@test.com' })).rejects.toMatchObject({
      message: expect.stringContaining('verification check'),
    });
    expect(postMock).not.toHaveBeenCalledWith('/api/otc/send', expect.anything());
  });

  it('reports a failed challenge to the server with its reason and error code', async () => {
    getMock.mockResolvedValue({ data: { turnstileSiteKey: 'site' } });
    solveMock.mockRejectedValue(new TurnstileError('error', 3, '110600'));
    postMock.mockResolvedValue({ data: undefined });
    const { result } = renderHook(() => useSendOTC(), { wrapper });
    await expect(result.current.mutateAsync({ email: 'x@test.com' })).rejects.toMatchObject({
      message: expect.stringContaining('refresh and try again'),
    });
    expect(postMock).toHaveBeenCalledWith('/api/turnstile/client-failure', {
      action: 'otc-send',
      reason: 'error',
      errorCode: '110600',
      attempts: 3,
    });
  });

  it('points a browser Cloudflare keeps rejecting at a regular browser instead of a refresh', async () => {
    getMock.mockResolvedValue({ data: { turnstileSiteKey: 'site' } });
    solveMock.mockRejectedValue(new TurnstileError('error', 3, '600010'));
    postMock.mockResolvedValue({ data: undefined });
    const { result } = renderHook(() => useSendOTC(), { wrapper });
    const rejection = await result.current.mutateAsync({ email: 'x@test.com' }).catch(e => e);
    expect(rejection.message).toContain('regular browser');
    expect(rejection.message).not.toContain('refresh');
    expect(postMock).toHaveBeenCalledWith('/api/turnstile/client-failure', {
      action: 'otc-send',
      reason: 'error',
      errorCode: '600010',
      attempts: 3,
    });
  });

  it('keeps the verification error when the failure report itself fails', async () => {
    getMock.mockResolvedValue({ data: { turnstileSiteKey: 'site' } });
    solveMock.mockRejectedValue(new Error('unexpected'));
    postMock.mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useSendOTC(), { wrapper });
    await expect(result.current.mutateAsync({ email: 'x@test.com' })).rejects.toMatchObject({
      message: expect.stringContaining('verification check'),
    });
    expect(postMock).toHaveBeenCalledWith('/api/turnstile/client-failure', {
      action: 'otc-send',
      reason: 'unavailable',
      attempts: 1,
    });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('solves the challenge the server asks for and retries once with its token', async () => {
    const required = new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST');
    required.response = {
      status: 403,
      statusText: 'Forbidden',
      headers: {},
      config: {},
      data: { error: 'Please complete the verification check.', code: 'challenge_required', siteKey: 'step-up' },
    } as AxiosResponse;
    postMock.mockRejectedValueOnce(required).mockResolvedValueOnce({ data: { pendingToken: 'pending' } });
    solveMock.mockResolvedValueOnce('step-up-token');
    const { result } = renderHook(() => useSendOTC(), { wrapper });

    await expect(result.current.mutateAsync({ email: 'x@test.com' })).resolves.toEqual({ pendingToken: 'pending' });

    expect(solveMock).toHaveBeenCalledExactlyOnceWith('step-up', 'otc-send');
    expect(postMock.mock.calls.map(call => call[1].turnstileToken)).toEqual([undefined, 'step-up-token']);
  });

  it('does not report a cancelled challenge or ask the user to refresh', async () => {
    getMock.mockResolvedValue({ data: { turnstileSiteKey: 'site' } });
    solveMock.mockRejectedValue(new TurnstileCancelledError());
    const { result } = renderHook(() => useSendOTC(), { wrapper });
    const rejection = await result.current.mutateAsync({ email: 'x@test.com' }).catch(e => e);
    expect(rejection.message).toContain('cancelled');
    expect(rejection.message).not.toContain('refresh');
    expect(postMock).not.toHaveBeenCalled();
  });
});
