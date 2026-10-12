import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';

const postMock = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: (...args: unknown[]) => postMock(...args) } }));

import { useSendOTC } from './auth';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
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
