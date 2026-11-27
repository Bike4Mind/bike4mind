import { vi } from 'vitest';
import { RUN_BUDGET_EXHAUSTED_ERROR_CODE, UnprocessableEntityError } from '@bike4mind/common';
import type { RunBudgetAdapters } from '../types';

/**
 * One budgeted run, standing in for CompletionRunRepository.claimBudget / releaseClaim. `transact` restores
 * `committedCredits` when its work throws, like the Mongo transaction it replaces.
 */
export const createFakeRunBudget = (options: { runId?: string; budgetCredits?: number } = {}) => {
  const runId = options.runId ?? 'run-1';
  const state = { budgetCredits: options.budgetCredits ?? 1_000_000, committedCredits: 0 };
  const adapters: RunBudgetAdapters = {
    claim: vi.fn(async (claimedRunId: string, credits: number) => {
      if (claimedRunId !== runId) return undefined;
      if (state.budgetCredits - state.committedCredits < credits) {
        throw new UnprocessableEntityError('run budget used up', { errorCode: RUN_BUDGET_EXHAUSTED_ERROR_CODE });
      }
      state.committedCredits += credits;
      return { runId, credits };
    }),
    release: vi.fn(async (claim: { runId: string; credits: number }, chargedCredits: number) => {
      state.committedCredits += chargedCredits - claim.credits;
    }),
    transact: vi.fn(async (work: () => Promise<unknown>) => {
      const before = state.committedCredits;
      try {
        return await work();
      } catch (error) {
        state.committedCredits = before;
        throw error;
      }
    }) as RunBudgetAdapters['transact'],
  };
  return { runId, state, adapters };
};
