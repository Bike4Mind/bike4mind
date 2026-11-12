import { nextUtcMidnight } from '@bike4mind/common';
import { pacedAllowance, pacedReadyAt, runCreditCap, type LoopAdmission } from '@bike4mind/common/loops';

/**
 * Admission before a Desktop loop run, in the server's order: the loop's daily budget and the all-loops budget each
 * have one iteration left, then their paced allowances cover one. Must stay in sync with loopAdmission
 * (apps/client/server/utils/loopBudget.ts). Account credits are not checked here: the completion route's refusal
 * (session.ts CREDIT_STOP) caps the loop instead. Spend is the local runs' credits; `price` is one iteration.
 */
export function localAdmission(
  loop: { budgetCreditsPerDay?: number },
  spend: { loop: number; allLoops: number; allLoopsCap?: number },
  price: number,
  now: Date
): LoopAdmission {
  const budgets: Array<{ budget: number; spent: number }> = [];
  if (loop.budgetCreditsPerDay) {
    if (loop.budgetCreditsPerDay - spend.loop < price) {
      return loop.budgetCreditsPerDay < price
        ? { ok: false, kind: 'loop_budget', belowOneRun: price }
        : { ok: false, kind: 'loop_budget' };
    }
    budgets.push({ budget: loop.budgetCreditsPerDay, spent: spend.loop });
  }
  if (spend.allLoopsCap) {
    if (spend.allLoopsCap - spend.allLoops < price) return { ok: false, kind: 'user_budget' };
    budgets.push({ budget: spend.allLoopsCap, spent: spend.allLoops });
  }

  const iteration = budgets.length > 0 ? price : 0;
  const tomorrow = nextUtcMidnight(now);
  const paced = budgets.map(({ budget, spent }) => ({
    remaining: pacedAllowance(budget, now) - spent,
    readyAt: pacedReadyAt(budget, spent, iteration, now) ?? tomorrow,
  }));
  const short = paced.filter(({ remaining }) => remaining < iteration);
  if (short.length > 0) {
    // No interval floor as on the server: a Desktop loop has no interval, its scheduler re-checks at readyAt.
    return { ok: false, kind: 'paced', readyAt: new Date(Math.max(...short.map(({ readyAt }) => readyAt.getTime()))) };
  }
  return {
    ok: true,
    iterationCredits: iteration,
    creditCap: runCreditCap([
      ...budgets.map(({ budget, spent }) => budget - spent),
      ...paced.map(({ remaining }) => remaining),
    ]),
  };
}
