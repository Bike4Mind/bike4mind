import type { QueryClient } from '@tanstack/react-query';
import { CREDITS_BALANCE_KEY, type CreditsBalance, fetchCreditsBalance, writeBilledBalance } from './credits';

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

// Invalidating refetches the balance wherever a query already holds it. When that refetch did not land (it failed or
// was cancelled, so the query is still invalidated) or no query held the balance (the Studio page has none of its
// own), read it fresh instead, so a cached pre-charge balance is never written back. A failed pull throws into the
// catch and leaves the `users` push to deliver the balance.
async function refreshPersonalBalance(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY, refetchType: 'all' });
  try {
    const state = queryClient.getQueryState<CreditsBalance>(CREDITS_BALANCE_KEY);
    const refetched = state !== undefined && !state.isInvalidated && state.data !== undefined;
    writeBilledBalance(
      refetched
        ? state.data
        : await queryClient.fetchQuery({ queryKey: CREDITS_BALANCE_KEY, queryFn: fetchCreditsBalance, staleTime: 0 })
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
