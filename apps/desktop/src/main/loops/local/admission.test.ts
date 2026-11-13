import { describe, expect, it } from 'vitest';
import { localAdmission } from './admission';

const noon = new Date(Date.UTC(2026, 0, 1, 12));
const price = 1;

// The same cases as the server's loopAdmission, minus the account-credit check Desktop learns from completions.
describe('localAdmission', () => {
  it.each([
    ['no budgets', {}, { loop: 0, allLoops: 0 }, { ok: true, iterationCredits: 0, creditCap: undefined }],
    [
      'loop budget spent',
      { budgetCreditsPerDay: 10 },
      { loop: 9.5, allLoops: 9.5 },
      { ok: false, kind: 'loop_budget' },
    ],
    [
      'loop budget below one run',
      { budgetCreditsPerDay: 0.5 },
      { loop: 0, allLoops: 0 },
      { ok: false, kind: 'loop_budget', belowOneRun: 1 },
    ],
    ['all-loops budget spent', {}, { loop: 0, allLoops: 99.5, allLoopsCap: 100 }, { ok: false, kind: 'user_budget' }],
  ] as const)('%s', (_name, loop, spend, expected) => {
    expect(localAdmission(loop, spend, price, noon)).toEqual(expected);
  });

  it('defers a loop ahead of its paced allowance until the allowance covers a run', () => {
    // At noon 13/24 of 24 credits (13) is allowed; 13 spent leaves nothing for a 1-credit run.
    const result = localAdmission({ budgetCreditsPerDay: 24 }, { loop: 13, allLoops: 13 }, price, noon);
    expect(result).toEqual({ ok: false, kind: 'paced', readyAt: new Date(Date.UTC(2026, 0, 1, 13)) });
  });

  it('caps an admitted run at the least of what is left and what pacing allows', () => {
    const result = localAdmission(
      { budgetCreditsPerDay: 24 },
      { loop: 2, allLoops: 50, allLoopsCap: 100 },
      price,
      noon
    );
    // Loop: 22 left, 13 - 2 = 11 paced. All loops: 50 left, 54.17 - 50 paced.
    expect(result.ok && result.creditCap).toBeCloseTo(100 * (13 / 24) - 50);
    expect(result).toMatchObject({ ok: true, iterationCredits: 1 });
  });
});
