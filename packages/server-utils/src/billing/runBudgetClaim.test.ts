import { beforeEach, describe, expect, it, vi } from 'vitest';

const { claimBudget, findById } = vi.hoisted(() => ({ claimBudget: vi.fn(), findById: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ completionRunRepository: { claimBudget, findById } }));

import { assertRunBudgetHeadroom, claimPaidCallRunBudget, claimRunBudget } from './runBudgetClaim';

describe('run budget refusals', () => {
  beforeEach(() => {
    claimBudget.mockReset();
    findById.mockReset();
  });

  it('says the budget is used up when a completion finds no room at all', async () => {
    claimBudget.mockResolvedValue({ kind: 'exhausted', budgetCredits: 70, committedCredits: 70 });

    await expect(claimRunBudget({ runId: 'r', wantedCredits: 40, minimumCredits: 1 })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('70 of its 70 credits'),
      additionalInfo: { errorCode: 'run_budget_exhausted' },
    });
  });

  it('names what a paid call needs against what the run has left, rather than calling it used up', async () => {
    claimBudget.mockResolvedValue({ kind: 'exhausted', budgetCredits: 70, committedCredits: 30 });

    const refusal = claimPaidCallRunBudget('r', 50);

    await expect(refusal).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/needs 50 credits, but this run has 40 of its 70 credits left/),
      additionalInfo: { errorCode: 'run_budget_exhausted' },
    });
    await expect(refusal).rejects.not.toMatchObject({ message: expect.stringContaining('used up') });
  });

  it('words the advisory headroom check the same way', async () => {
    findById.mockResolvedValue({ budgetCredits: 70, committedCredits: 30 });

    await expect(assertRunBudgetHeadroom('r', 50)).rejects.toMatchObject({
      message: expect.stringMatching(/needs 50 credits, but this run has 40 of its 70 credits left/),
    });
  });
});
