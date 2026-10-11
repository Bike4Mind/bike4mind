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
