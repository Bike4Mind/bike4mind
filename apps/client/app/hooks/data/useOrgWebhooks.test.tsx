import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { orgWebhookQueryKeys, useCreateOrgWebhookConfig, useGetOrgWebhookConfig } from './useOrgWebhooks';

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const setup = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
};

beforeEach(() => vi.clearAllMocks());

describe('useOrgWebhooks', () => {
  it('reads the config without any reveal parameter', async () => {
    api.get.mockResolvedValue({ data: { id: 'cfg-1', secretMasked: '****' } });
    const { wrapper } = setup();
    renderHook(() => useGetOrgWebhookConfig('org-1'), { wrapper });

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(api.get).toHaveBeenCalledWith('/api/organizations/org-1/webhooks/github');
  });

  it('resolves create with the secret but keeps it out of the query cache', async () => {
    api.post.mockResolvedValue({
      data: { id: 'cfg-1', organizationId: 'org-1', secret: 'fake-webhook-secret-1234', secretMasked: '****1234' },
    });
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useCreateOrgWebhookConfig(), { wrapper });

    const created = await result.current.mutateAsync({ orgId: 'org-1', data: { repos: [], subscribedEvents: [] } });

    expect(created.secret).toBe('fake-webhook-secret-1234');
    const cached = queryClient.getQueryData<{ secret?: string; secretMasked?: string }>(
      orgWebhookQueryKeys.config('org-1')
    );
    expect(cached?.secret).toBeUndefined();
    expect(cached?.secretMasked).toBe('****1234');
  });
});
