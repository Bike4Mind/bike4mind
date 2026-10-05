import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { useSetMemberCreditDefault, useSetMemberCreditOverride } from './organizations';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put: vi.fn() } }));

const put = api.put as unknown as Mock;

const renderWithClient = <T,>(useHook: () => T) => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(useHook, { wrapper });
  return { result, invalidateSpy };
};

describe('credit budget mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    put.mockResolvedValue({ data: { id: 'org1' } });
  });

  it('useSetMemberCreditDefault PUTs maxCreditsPerMember and invalidates organizations', async () => {
    const { result, invalidateSpy } = renderWithClient(useSetMemberCreditDefault);

    await result.current.mutateAsync({ organizationId: 'org1', maxCreditsPerMember: 500 });

    expect(put).toHaveBeenCalledWith('/api/organizations/org1/member-credit-budget', { maxCreditsPerMember: 500 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organizations'] });
    expect(toast.success).toHaveBeenCalledWith('Monthly credit limit updated');
  });

  it('useSetMemberCreditDefault sends null to remove the limit', async () => {
    const { result } = renderWithClient(useSetMemberCreditDefault);

    await result.current.mutateAsync({ organizationId: 'org1', maxCreditsPerMember: null });

    expect(put).toHaveBeenCalledWith('/api/organizations/org1/member-credit-budget', { maxCreditsPerMember: null });
  });

  it('useSetMemberCreditOverride PUTs maxCredits for one member and invalidates organizations', async () => {
    const { result, invalidateSpy } = renderWithClient(useSetMemberCreditOverride);

    await result.current.mutateAsync({ organizationId: 'org1', userId: 'user1', maxCredits: 0 });

    expect(put).toHaveBeenCalledWith('/api/organizations/org1/members/user1/credit-budget', { maxCredits: 0 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organizations'] });
  });

  it.each([
    ['useSetMemberCreditDefault', useSetMemberCreditDefault, { organizationId: 'org1', maxCreditsPerMember: 5 }],
    [
      'useSetMemberCreditOverride',
      useSetMemberCreditOverride,
      { organizationId: 'org1', userId: 'user1', maxCredits: 5 },
    ],
  ] as const)(
    '%s rejects, toasts the failure and does not invalidate when the request fails',
    async (_name, useHook, variables) => {
      put.mockRejectedValue(new Error('boom'));
      const { result, invalidateSpy } = renderWithClient(useHook);

      await expect(result.current.mutateAsync(variables as never)).rejects.toThrow('boom');

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('boom')));
      expect(toast.success).not.toHaveBeenCalled();
      expect(invalidateSpy).not.toHaveBeenCalled();
    }
  );
});
