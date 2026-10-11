import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useUser } from '@client/app/contexts/UserContext';
import { CREDITS_BALANCE_KEY, fetchCreditsBalance } from '@client/app/hooks/data/credits';
import { useStreamingState } from '@client/app/hooks/useStreamingState';

/**
 * After a turn ends, settlement can land a beat later, so pull twice: the first catches the
 * usual case within about a second, the second a slow settle (ms, from the end of streaming).
 */
export const BALANCE_SYNC_DELAYS_MS = [1500, 5000] as const;

/**
 * Pull the billed balance from the server and write it where the composer chip reads it:
 * `currentUser.currentCredits` for the personal account, the organization queries for a team
 * pool. Failures are swallowed; the `users` push and the next identify still apply.
 */
export async function syncCreditBalance(queryClient: QueryClient): Promise<void> {
  // The organization the sends carried (see CreditPayerNote for why not the account menu's pick).
  if (useLLM.getState().organizationId) {
    await queryClient.invalidateQueries({ queryKey: ['organizations'] });
  }
  try {
    const balance = await queryClient.fetchQuery({
      queryKey: CREDITS_BALANCE_KEY,
      queryFn: fetchCreditsBalance,
      staleTime: 0,
    });
    const { currentUser, setCurrentUser } = useUser.getState();
    if (
      currentUser &&
      typeof balance?.currentCredits === 'number' &&
      balance.currentCredits !== currentUser.currentCredits
    ) {
      setCurrentUser({ ...currentUser, currentCredits: balance.currentCredits });
    }
  } catch (error) {
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

  useEffect(() => {
    let timers: ReturnType<typeof setTimeout>[] = [];
    let wasStreaming = useStreamingState.getState().isAnyStreaming();

    const unsubscribe = useStreamingState.subscribe(state => {
      const streaming = state.isAnyStreaming();
      if (wasStreaming && !streaming) {
        timers.forEach(clearTimeout);
        timers = BALANCE_SYNC_DELAYS_MS.map(delay => setTimeout(() => void syncCreditBalance(queryClient), delay));
      }
      wasStreaming = streaming;
    });

    return () => {
      unsubscribe();
      timers.forEach(clearTimeout);
    };
  }, [queryClient]);

  return null;
};

export default CreditBalanceSyncListener;
