import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { API_KEY_TRUST_REQUIRED_ERROR_CODE } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useApiKeyEligibility, useCreateUserApiKey } from './userApiKeys';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return wrapper;
};

const newKeyRequest = { name: 'k', scopes: [], rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 } };
const serverError = (data: Record<string, unknown>) => ({ response: { status: 403, data }, message: 'Request failed' });

describe('useCreateUserApiKey - error toast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toasts the trust-required server message verbatim, including colons and commas', async () => {
    const message = 'Personal API keys need approval: ask an admin, or bill an organization.';
    post.mockRejectedValue(serverError({ errorCode: API_KEY_TRUST_REQUIRED_ERROR_CODE, error: message }));
    const { result } = renderHook(() => useCreateUserApiKey(), { wrapper: createWrapper() });

    await expect(result.current.mutateAsync(newKeyRequest)).rejects.toBeDefined();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
  });

  it('still reformats Zod-style validation errors that carry no trust error code', async () => {
    post.mockRejectedValue(serverError({ error: 'rateLimit.requestsPerMinute: Too big' }));
    const { result } = renderHook(() => useCreateUserApiKey(), { wrapper: createWrapper() });

    await expect(result.current.mutateAsync(newKeyRequest)).rejects.toBeDefined();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Rate limit requests per minute: Too big'));
  });
});

describe('useApiKeyEligibility - refetch after create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refetches eligibility once a create succeeds', async () => {
    get.mockResolvedValue({ data: { canCreate: true, message: null } });
    post.mockResolvedValue({ data: { key: 'b4m_live_x' } });
    const { result } = renderHook(() => ({ eligibility: useApiKeyEligibility(), create: useCreateUserApiKey() }), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.eligibility.data).toEqual({ canCreate: true, message: null }));
    expect(get).toHaveBeenCalledTimes(1);

    get.mockResolvedValue({ data: { canCreate: false, message: 'Trust revoked.' } });
    await result.current.create.mutateAsync(newKeyRequest);

    await waitFor(() =>
      expect(result.current.eligibility.data).toEqual({ canCreate: false, message: 'Trust revoked.' })
    );
    expect(get).toHaveBeenCalledTimes(2);
  });
});
