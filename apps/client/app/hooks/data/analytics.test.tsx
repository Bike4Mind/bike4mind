import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPost = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mockPost } }));

import { useLogPoliciesShown } from './analytics';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

describe('useLogPoliciesShown', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it('records the interstitial through the narrow pre-consent endpoint with an empty body', async () => {
    mockPost.mockResolvedValue({ status: 204 });
    const { result } = renderHook(() => useLogPoliciesShown(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledExactlyOnceWith('/api/user/accept-policies/shown', {});
  });

  it('reports telemetry failure without rejecting a fire-and-forget mutation', async () => {
    const error = new Error('Offline');
    mockPost.mockRejectedValue(error);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { result } = renderHook(() => useLogPoliciesShown(), { wrapper });
      act(() => result.current.mutate());
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(warning).toHaveBeenCalledWith('Policy interstitial analytics logging failed:', error);
    } finally {
      warning.mockRestore();
    }
  });
});
