import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { useReconcileOrgSeats } from './adminOrganizations';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn() } }));

const post = api.post as unknown as Mock;

const renderReconcile = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useReconcileOrgSeats(), { wrapper });
  return { result, invalidateSpy };
};

describe('useReconcileOrgSeats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toasts the before -> after change and invalidates organizations on success', async () => {
    post.mockResolvedValue({ data: { organizationId: 'org1', before: 10, after: 30 } });
    const { result, invalidateSpy } = renderReconcile();

    await result.current.mutateAsync({ organizationId: 'org1' });

    expect(post).toHaveBeenCalledWith('/api/admin/organizations/org1/reconcile-seats');
    expect(toast.success).toHaveBeenCalledWith('Seats reconciled: 10 -> 30');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organizations'] });
  });

  it('toasts an already-in-sync message when seats did not change', async () => {
    post.mockResolvedValue({ data: { organizationId: 'org1', before: 30, after: 30 } });
    const { result } = renderReconcile();

    await result.current.mutateAsync({ organizationId: 'org1' });

    expect(toast.success).toHaveBeenCalledWith('Seats already in sync (30)');
  });

  it('surfaces the server error message on failure', async () => {
    post.mockRejectedValue(new Error('Organization has no active subscription to reconcile seats from'));
    const { result } = renderReconcile();

    await expect(result.current.mutateAsync({ organizationId: 'org1' })).rejects.toThrow();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Organization has no active subscription to reconcile seats from')
    );
  });
});
