import { describe, expect, it } from 'vitest';
import { runBudgetPausedMessage, runBudgetWarning } from './runBudget';

describe('runBudgetPausedMessage', () => {
  it('names the budget with spent and reserved when the usage read succeeded', () => {
    expect(
      runBudgetPausedMessage(500, {
        budgetCredits: 1200,
        committedCredits: 1200,
        reservedCredits: 200,
        remainingCredits: 0,
      })
    ).toBe(
      'Paused: this orchestration run has used its 1,200-credit budget (1,000 spent, 200 reserved). Raise the budget to resume; the work so far is kept.'
    );
  });

  it('falls back to the local budget, then to no number, when the read failed', () => {
    expect(runBudgetPausedMessage(500)).toBe(
      'Paused: this orchestration run has used its 500-credit budget. Raise the budget to resume; the work so far is kept.'
    );
    expect(runBudgetPausedMessage()).toMatch(/^Paused: this orchestration run has used its credit budget\./);
  });
});

describe('runBudgetWarning', () => {
  it('is silent below 80% committed', () => {
    expect(
      runBudgetWarning({ budgetCredits: 1000, committedCredits: 799, reservedCredits: 0, remainingCredits: 201 })
    ).toBeUndefined();
  });

  it('counts reserved credits toward the 80% and shows them apart from spent', () => {
    expect(
      runBudgetWarning({ budgetCredits: 1000, committedCredits: 800, reservedCredits: 300, remainingCredits: 200 })
    ).toBe(
      'This orchestration run has committed 80% of its 1,000-credit budget (500 spent, 300 reserved, 200 left). It pauses when the budget runs out.'
    );
  });
});
