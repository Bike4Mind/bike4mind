import type { CompletionRunBudgetState } from '@bike4mind/common';

/** The share of a run budget committed at which the run warns, once per budget. */
export const RUN_BUDGET_WARNING_RATIO = 0.8;

const credits = (amount: number): string => Math.round(amount).toLocaleString('en-US');

/**
 * Spent and reserved, as the thread shows them. Spent is what has settled; reserved is held by
 * completions still running (or awaiting the expired-hold sweep), and both count against the budget.
 */
function spentAndReserved(state: CompletionRunBudgetState): string {
  const spent = Math.max(0, state.committedCredits - state.reservedCredits);
  return `${credits(spent)} spent, ${credits(state.reservedCredits)} reserved`;
}

/**
 * The fixed text a budget-stopped turn stores. Deterministic by design: no model is asked to
 * explain a stop the run can no longer pay for. `state` is omitted when the usage read failed.
 * The server refuses a request whose hold does not fit in what is left, so a run can pause with
 * credits remaining; the text then says so rather than claiming the budget is used up.
 */
export function runBudgetPausedMessage(budgetCredits?: number, state?: CompletionRunBudgetState): string {
  const resume = 'Raise the budget to resume; the work so far is kept.';
  const budget = state?.budgetCredits ?? budgetCredits;
  const what = budget !== undefined ? `its ${credits(budget)}-credit budget` : 'its credit budget';
  if (state && state.remainingCredits > 0) {
    return (
      `Paused: the next request does not fit in what is left of this orchestration run's ` +
      `${credits(state.budgetCredits)}-credit budget (${spentAndReserved(state)}, ` +
      `${credits(state.remainingCredits)} left). ${resume}`
    );
  }
  const detail = state ? ` (${spentAndReserved(state)})` : '';
  return `Paused: this orchestration run has used ${what}${detail}. ${resume}`;
}

/** The 80% notice for `state`, or `undefined` while the run is below it. */
export function runBudgetWarning(state: CompletionRunBudgetState): string | undefined {
  if (state.committedCredits < state.budgetCredits * RUN_BUDGET_WARNING_RATIO) return undefined;
  const percent = Math.min(100, Math.floor((state.committedCredits / state.budgetCredits) * 100));
  return (
    `This orchestration run has committed ${percent}% of its ${credits(state.budgetCredits)}-credit budget ` +
    `(${spentAndReserved(state)}, ${credits(state.remainingCredits)} left). It pauses when the budget runs out.`
  );
}
