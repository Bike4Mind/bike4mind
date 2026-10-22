import { useEffect } from 'react';
import { isCancelledError, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useUser } from '@client/app/contexts/UserContext';
import { CREDITS_BALANCE_KEY, fetchCreditsBalance } from '@client/app/hooks/data/credits';
import { useCreditSyncSignal } from '@client/app/hooks/useCreditSyncSignal';
import { useStreamingState } from '@client/app/hooks/useStreamingState';

/**
 * After a turn ends, settlement can land a beat later, so pull twice: the first catches the
 * usual case within about a second, the second a slow settle (ms, from the end of streaming).
 * `POST_STREAM_HOLD_MAX_MS` in useEffectiveCredits must stay above the last entry.
 */
export const BALANCE_SYNC_DELAYS_MS = [1500, 5000] as const;

/**
 * Pull the billed balance from the server and write it where the composer chip reads it:
 * `currentUser.currentCredits` for the personal account, the organization queries for a team
 * pool. Failures are swallowed; the `users` push and the next identify still apply.
 * `isStale` lets a caller drop a pull that a newer turn has overtaken: its result is not
 * written, since it would release the newer turn's hold before that turn's own pulls land.
 */
export async function syncCreditBalance(queryClient: QueryClient, isStale?: () => boolean): Promise<void> {
  if (isStale?.()) return;
  // The organization the sends carried (see CreditPayerNote for why not the account menu's pick).
  if (useLLM.getState().organizationId) {
    await queryClient.invalidateQueries({ queryKey: ['organizations'] });
    if (isStale?.()) return;
  }
  try {
    const balance = await queryClient.fetchQuery({
      queryKey: CREDITS_BALANCE_KEY,
      queryFn: fetchCreditsBalance,
      staleTime: 0,
    });
    if (isStale?.()) return;
    const { currentUser, setCurrentUser } = useUser.getState();
    if (
      currentUser &&
      typeof balance?.currentCredits === 'number' &&
      balance.currentCredits !== currentUser.currentCredits
    ) {
      setCurrentUser({ ...currentUser, currentCredits: balance.currentCredits });
    }
  } catch (error) {
    if (isStale?.() || isCancelledError(error)) return;
    console.warn('Credit balance sync failed:', error);
  }
}

/**
 * Keeps the composer credit chip in step with billing. The chip otherwise depends only on the
 * `users` collection push (UserContext), and when that push is late or lost it stayed stale
 * until a reload. Fires when the last streaming turn ends (completion, stop, error recovery and
 * the stream timeout all clear it - see useStreamingState). Mounted once in app/providers.tsx.
 */
const CreditBalanceSyncListener = () => {
  const queryClient = useQueryClient();
  const markSynced = useCreditSyncSignal(state => state.markSynced);

  useEffect(() => {
    let timers: ReturnType<typeof setTimeout>[] = [];
    let wasStreaming = useStreamingState.getState().isAnyStreaming();
    // Clearing the timers only cancels pulls that have not fired; one already in flight
    // from an earlier turn is told apart by this counter.
    let turnEnds = 0;
    let pullsInFlight = 0;

    const cancelPendingPulls = () => {
      void queryClient.cancelQueries({ queryKey: CREDITS_BALANCE_KEY, exact: true });
      // The old pull may belong to a team even if the account selection has since changed.
      void queryClient.cancelQueries({
        queryKey: ['organizations'],
        predicate: query => query.state.data !== undefined,
      });
    };

    const unsubscribe = useStreamingState.subscribe(state => {
      const streaming = state.isAnyStreaming();
      if (wasStreaming && !streaming) {
        timers.forEach(clearTimeout);
        const turn = ++turnEnds;
        // A newer fetchQuery otherwise shares an older pending promise, bypassing its stale guard.
        if (pullsInFlight > 0) cancelPendingPulls();
        const isStale = () => turn !== turnEnds;
        timers = BALANCE_SYNC_DELAYS_MS.map((delay, index) =>
          setTimeout(() => {
            pullsInFlight += 1;
            // Only the last pull confirms the balance: an unchanged first pull may just be a slow settle.
            const isLast = index === BALANCE_SYNC_DELAYS_MS.length - 1;
            // Each polling point must read a fresh balance, including when the first pull is slow.
            const pull = async () => {
              await queryClient.cancelQueries({ queryKey: CREDITS_BALANCE_KEY, exact: true });
              await syncCreditBalance(queryClient, isStale);
            };
            void pull().finally(() => {
              pullsInFlight -= 1;
              if (isLast && !isStale()) markSynced();
            });
          }, delay)
        );
      }
      wasStreaming = streaming;
    });

    return () => {
      turnEnds += 1;
      unsubscribe();
      if (pullsInFlight > 0) cancelPendingPulls();
      timers.forEach(clearTimeout);
    };
  }, [queryClient, markSynced]);

  return null;
};

export default CreditBalanceSyncListener;
