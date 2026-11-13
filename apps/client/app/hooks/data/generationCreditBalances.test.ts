import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: apiGet } }));

import type { IUserDocument } from '@bike4mind/database';
import { useUser } from '@client/app/contexts/UserContext';
import { CREDITS_BALANCE_KEY } from './credits';
import { hasGenerationCreditSettlementChanged, invalidateGenerationCreditBalances } from './generationCreditBalances';

describe('invalidateGenerationCreditBalances', () => {
  it('refreshes inactive personal and team balances without refetching unrelated organization queries', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, refetchOnMount: false, retry: false, gcTime: Infinity } },
    });
    const organizationsKey = ['organizations', 'user', 'user-1'];
    const searchKey = ['organizations', 'search', 'team'];
    const fetchPersonalBalance = vi.fn().mockResolvedValue({ currentCredits: 100 });
    const fetchOrganizations = vi.fn().mockResolvedValue([{ id: 'team-1', currentCredits: 200 }]);
    const searchOrganizations = vi.fn().mockResolvedValue([]);

    try {
      await Promise.all([
        queryClient.fetchQuery({ queryKey: CREDITS_BALANCE_KEY, queryFn: fetchPersonalBalance }),
        queryClient.fetchQuery({ queryKey: organizationsKey, queryFn: fetchOrganizations }),
        queryClient.fetchQuery({ queryKey: searchKey, queryFn: searchOrganizations }),
      ]);
      fetchPersonalBalance.mockResolvedValue({ currentCredits: 90 });
      fetchOrganizations.mockResolvedValue([{ id: 'team-1', currentCredits: 180 }]);

      await invalidateGenerationCreditBalances(queryClient);

      expect(queryClient.getQueryData(CREDITS_BALANCE_KEY)).toEqual({ currentCredits: 90 });
      expect(queryClient.getQueryData(organizationsKey)).toEqual([{ id: 'team-1', currentCredits: 180 }]);
      expect(searchOrganizations).toHaveBeenCalledTimes(1);
    } finally {
      queryClient.clear();
    }
  });

  it('writes the refreshed personal balance to the current user, fetching it when nothing holds it yet', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useUser.getState().setCurrentUser({ id: 'user-1', currentCredits: 100 } as unknown as IUserDocument);
    apiGet.mockResolvedValue({ data: { currentCredits: 52 } });

    try {
      await invalidateGenerationCreditBalances(queryClient);

      expect(apiGet).toHaveBeenCalledWith('/api/credits/balance');
      expect(useUser.getState().currentUser?.currentCredits).toBe(52);
    } finally {
      queryClient.clear();
      useUser.getState().setCurrentUser(null);
    }
  });
});

describe('hasGenerationCreditSettlementChanged', () => {
  it.each([
    [undefined, null, false],
    [undefined, 0, true],
    [undefined, 5, true],
    [null, null, false],
    [null, 0, true],
    [null, 5, true],
    [0, null, false],
    [0, 0, false],
    [5, null, false],
    [5, 5, false],
    [5, 3, true],
  ] as const)('detects the persisted settlement changing from %s to %s', (before, after, expected) => {
    expect(
      hasGenerationCreditSettlementChanged(before === undefined ? undefined : { credits: { settled: before } }, {
        credits: { settled: after },
      })
    ).toBe(expected);
  });
});
