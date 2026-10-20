import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({ balance: 9_903 }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(async () => ({ data: { currentCredits: h.balance, expiringSoon: [] } })) },
}));

import { api } from '@client/app/contexts/ApiContext';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useCreditSyncSignal } from '@client/app/hooks/useEffectiveCredits';
import { useStreamingState } from '@client/app/hooks/useStreamingState';
import CreditBalanceSyncListener, { BALANCE_SYNC_DELAYS_MS } from './CreditBalanceSyncListener';

let queryClient: QueryClient;

const renderListener = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <CreditBalanceSyncListener />
    </QueryClientProvider>
  );

const runTurn = () => {
  act(() => {
    useStreamingState.getState().startStreaming('session-a', 'q-1');
  });
  act(() => {
    useStreamingState.getState().completeStreaming('session-a');
  });
};

describe('CreditBalanceSyncListener', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.get).mockClear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    h.balance = 9_903;
    useLLM.setState({ organizationId: null });
    useUser.getState().setCurrentUser({ id: 'u1', currentCredits: 10_000 } as IUserDocument);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pulls the billed balance into the user store shortly after a turn ends', async () => {
    renderListener();
    runTurn();
    expect(api.get).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[0]);
    });

    expect(api.get).toHaveBeenCalledWith('/api/credits/balance');
    expect(useUser.getState().currentUser?.currentCredits).toBe(9_903);
  });

  it('pulls again later to catch a settlement that lands after the first pull', async () => {
    renderListener();
    runTurn();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[0]);
    });
    h.balance = 9_880;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[1] - BALANCE_SYNC_DELAYS_MS[0]);
    });

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(useUser.getState().currentUser?.currentCredits).toBe(9_880);
  });

  it('signals only after the last pull, even when the balance did not change', async () => {
    h.balance = 10_000;
    const before = useCreditSyncSignal.getState().syncCount;
    renderListener();
    runTurn();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[0]);
    });
    expect(useCreditSyncSignal.getState().syncCount).toBe(before);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[1] - BALANCE_SYNC_DELAYS_MS[0]);
    });

    expect(useUser.getState().currentUser?.currentCredits).toBe(10_000);
    expect(useCreditSyncSignal.getState().syncCount).toBe(before + 1);
  });

  describe('a pull still in flight from an earlier turn', () => {
    // Holds the next api.get open so the pull is mid-request when the next turn ends.
    const holdNextRequest = () => {
      let resolve!: (balance: number) => void;
      vi.mocked(api.get).mockImplementationOnce(
        () =>
          new Promise(res => {
            resolve = balance => res({ data: { currentCredits: balance, expiringSoon: [] } } as never);
          })
      );
      return (balance: number) => resolve(balance);
    };

    it('does not write its balance once a newer turn has ended', async () => {
      renderListener();
      runTurn();
      const resolveStale = holdNextRequest();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[0]);
      });
      runTurn();

      await act(async () => {
        resolveStale(1_234);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(useUser.getState().currentUser?.currentCredits).toBe(10_000);
    });

    it('does not signal the newer turn as confirmed when its last pull resolves late', async () => {
      renderListener();
      runTurn();
      const before = useCreditSyncSignal.getState().syncCount;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[0]);
      });
      const resolveStale = holdNextRequest();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[1] - BALANCE_SYNC_DELAYS_MS[0]);
      });
      runTurn();

      await act(async () => {
        resolveStale(1_234);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(useCreditSyncSignal.getState().syncCount).toBe(before);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[1]);
      });
      expect(useCreditSyncSignal.getState().syncCount).toBe(before + 1);
    });
  });

  it('still signals after the last pull when the balance request fails (the failure is swallowed in syncCreditBalance)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(api.get).mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce(new Error('network'));
    const before = useCreditSyncSignal.getState().syncCount;
    renderListener();
    runTurn();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[1]);
    });

    expect(useCreditSyncSignal.getState().syncCount).toBe(before + 1);
    warn.mockRestore();
  });

  it('does nothing while no turn has ended', async () => {
    renderListener();
    act(() => {
      useStreamingState.getState().startStreaming('session-a', 'q-1');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[1]);
    });

    expect(api.get).not.toHaveBeenCalled();
    act(() => {
      useStreamingState.getState().resetStreaming('session-a');
    });
  });

  it('refreshes the organization pool when a team account is paying', async () => {
    useLLM.setState({ organizationId: 'org-1' });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderListener();
    runTurn();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BALANCE_SYNC_DELAYS_MS[0]);
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['organizations'] });
  });
});
