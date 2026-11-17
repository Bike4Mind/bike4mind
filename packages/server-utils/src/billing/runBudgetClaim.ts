import { RUN_BUDGET_EXHAUSTED_ERROR_CODE, UnprocessableEntityError, type RunBudgetClaim } from '@bike4mind/common';
import { completionRunRepository } from '@bike4mind/database';

/** The deterministic refusal a client shows when a run has no headroom left; no model call writes it. */
export function runBudgetExhaustedMessage(budgetCredits: number, committedCredits: number): string {
  return (
    `This run's credit budget is used up: ${committedCredits} of its ${budgetCredits} credits are spent or ` +
    'reserved by requests still running. Retry once those requests finish, or raise the run budget.'
  );
}

/**
 * Claims up to `wantedCredits` of a run's budget, and at least `minimumCredits`, or throws a 422
 * `run_budget_exhausted`. Resolves `undefined` for an unbudgeted run. Callers check the run's owner
 * first (claimBudget does not), and call this inside the transaction that moves the balance, so a
 * refused claim moves nothing and a claim never outlives a rolled-back hold.
 */
export async function claimRunBudget(claim: {
  runId: string;
  wantedCredits: number;
  minimumCredits: number;
}): Promise<number | undefined> {
  const outcome = await completionRunRepository.claimBudget(claim.runId, claim.wantedCredits, claim.minimumCredits);
  if (outcome.kind === 'exhausted') {
    throw new UnprocessableEntityError(runBudgetExhaustedMessage(outcome.budgetCredits, outcome.committedCredits), {
      errorCode: RUN_BUDGET_EXHAUSTED_ERROR_CODE,
    });
  }
  return outcome.kind === 'claimed' ? outcome.credits : undefined;
}

/**
 * The all-or-nothing claim of a paid tool call: unlike a completion, a render or a clip cannot be cut
 * short to fit what is left, so the whole hold must fit in the run or the call is refused.
 */
export async function claimPaidCallRunBudget(runId: string, credits: number): Promise<RunBudgetClaim | undefined> {
  if (credits <= 0) return undefined;
  const claimed = await claimRunBudget({ runId, wantedCredits: credits, minimumCredits: credits });
  return claimed === undefined ? undefined : { runId, credits: claimed };
}

/**
 * Swaps a claim for what its hold charged: 0 on a refund or sweep, the recorded charge on settlement.
 * Call it in the transaction that ends the hold, so the run and the balance never disagree.
 */
export async function releaseRunBudgetClaim(claim: RunBudgetClaim | undefined, chargedCredits: number): Promise<void> {
  if (claim) await completionRunRepository.releaseClaim(claim, chargedCredits);
}
