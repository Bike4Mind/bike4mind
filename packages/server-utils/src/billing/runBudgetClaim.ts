import { RUN_BUDGET_EXHAUSTED_ERROR_CODE, UnprocessableEntityError, type RunBudgetClaim } from '@bike4mind/common';
import { completionRunRepository } from '@bike4mind/database';

/**
 * The deterministic refusal a client shows when a run has no headroom left; no model call writes it.
 * `neededCredits` is what the refused call needed (a paid call's whole hold, a completion's minimum):
 * such a call can be refused while the run still has room, so the message names the shortfall instead
 * of calling the budget used up.
 */
export function runBudgetExhaustedMessage(
  budgetCredits: number,
  committedCredits: number,
  neededCredits?: number
): string {
  const leftCredits = Math.max(0, budgetCredits - committedCredits);
  if (neededCredits !== undefined && leftCredits > 0) {
    return (
      `This call needs ${neededCredits} credits, but this run has ${leftCredits} of its ${budgetCredits} ` +
      'credits left. Retry once requests still running finish, or raise the run budget.'
    );
  }
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
  /** Named in the refusal as the credits the call needs (runBudgetExhaustedMessage). */
  neededCredits?: number;
  /** Caps the claim above `minimumCredits` at this share of the rest (CompletionRunRepository.claimBudget). */
  maxShareOfRemaining?: number;
}): Promise<number | undefined> {
  const outcome = await completionRunRepository.claimBudget(
    claim.runId,
    claim.wantedCredits,
    claim.minimumCredits,
    claim.maxShareOfRemaining
  );
  if (outcome.kind === 'exhausted') {
    throw new UnprocessableEntityError(
      runBudgetExhaustedMessage(outcome.budgetCredits, outcome.committedCredits, claim.neededCredits),
      { errorCode: RUN_BUDGET_EXHAUSTED_ERROR_CODE }
    );
  }
  return outcome.kind === 'claimed' ? outcome.credits : undefined;
}

/**
 * A non-claiming check that `credits` still fit what a run has left, for a route that queues work whose
 * real claim is taken later with its hold (image generation). Throws the same 422 a claim would; a no-op
 * for an unbudgeted run. Advisory only: concurrent work can still use the room up, so the claim decides.
 */
export async function assertRunBudgetHeadroom(runId: string, credits: number): Promise<void> {
  const run = await completionRunRepository.findById(runId);
  if (run?.budgetCredits === undefined) return;
  const committedCredits = run.committedCredits ?? 0;
  if (credits > run.budgetCredits - committedCredits) {
    throw new UnprocessableEntityError(runBudgetExhaustedMessage(run.budgetCredits, committedCredits, credits), {
      errorCode: RUN_BUDGET_EXHAUSTED_ERROR_CODE,
    });
  }
}

/**
 * The all-or-nothing claim of a paid tool call: unlike a completion, a render or a clip cannot be cut
 * short to fit what is left, so the whole hold must fit in the run or the call is refused.
 */
export async function claimPaidCallRunBudget(runId: string, credits: number): Promise<RunBudgetClaim | undefined> {
  if (credits <= 0) return undefined;
  const claimed = await claimRunBudget({
    runId,
    wantedCredits: credits,
    minimumCredits: credits,
    neededCredits: credits,
  });
  return claimed === undefined ? undefined : { runId, credits: claimed };
}

/**
 * Swaps a claim for what its hold charged: 0 on a refund or sweep, the recorded charge on settlement.
 * Call it in the transaction that ends the hold, so the run and the balance never disagree.
 */
export async function releaseRunBudgetClaim(claim: RunBudgetClaim | undefined, chargedCredits: number): Promise<void> {
  if (claim) await completionRunRepository.releaseClaim(claim, chargedCredits);
}
