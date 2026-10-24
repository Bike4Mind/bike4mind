import type { QueryClient } from '@tanstack/react-query';
import { CREDITS_BALANCE_KEY } from './credits';

export async function invalidateGenerationCreditBalances(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY, refetchType: 'all' }),
    // The account list disables refetchOnMount, and a job can settle after its observer unmounts.
    queryClient.invalidateQueries({ queryKey: ['organizations', 'user'], refetchType: 'all' }),
  ]);
}

type CreditSettlement = { credits: { settled: number | null } };

/** Settlement is written after the charge or refund, later than the terminal job state. */
export function hasGenerationCreditSettlementChanged(
  previous: CreditSettlement | undefined,
  job: CreditSettlement
): boolean {
  return job.credits.settled !== null && previous?.credits.settled !== job.credits.settled;
}
