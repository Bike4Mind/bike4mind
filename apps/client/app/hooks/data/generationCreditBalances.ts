import type { QueryClient } from '@tanstack/react-query';
import { CREDITS_BALANCE_KEY, fetchCreditsBalance, writeBilledBalance } from './credits';

/**
 * Refresh every balance a generation's charge or refund moves; every Studio medium calls this at submit and at
 * settlement. The refetched personal balance is also written to `currentUser.currentCredits`, which the composer
 * chip and the Studio header read, so they no longer wait on the `users` push.
 */
export async function invalidateGenerationCreditBalances(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    refreshPersonalBalance(queryClient),
    // The account list disables refetchOnMount, and a job can settle after its observer unmounts.
    queryClient.invalidateQueries({ queryKey: ['organizations', 'user'], refetchType: 'all' }),
  ]);
}

// Always a fresh read (staleTime 0), never the cached pre-charge balance, and it throws when the pull fails: a failed
// pull leaves the `users` push to deliver the balance. Matches syncCreditBalance in CreditBalanceSyncListener.
async function refreshPersonalBalance(queryClient: QueryClient): Promise<void> {
  try {
    writeBilledBalance(
      await queryClient.fetchQuery({ queryKey: CREDITS_BALANCE_KEY, queryFn: fetchCreditsBalance, staleTime: 0 })
    );
  } catch (error) {
    console.warn('Credit balance sync failed:', error);
  }
}

type CreditSettlement = { credits: { settled: number | null } };

/** Settlement is written after the charge or refund, later than the terminal job state. */
export function hasGenerationCreditSettlementChanged(
  previous: CreditSettlement | undefined,
  job: CreditSettlement
): boolean {
  return job.credits.settled !== null && previous?.credits.settled !== job.credits.settled;
}
