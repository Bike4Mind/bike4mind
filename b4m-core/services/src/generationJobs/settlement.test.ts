import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type CompletionRunAttribution, type IGenerationJobDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import type { CreditHold, CreditHoldAdapters, CreditLedgerEntry } from '../creditService/creditHold';
import { createFakeRunBudget } from './__test__/fakeRunBudget';
import { releaseJobHold, settleJobHold, type JobSettlementDeps } from './settlement';

vi.mock('../creditService/creditHold', () => ({
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_hold: unknown, charged: number) => charged),
}));
import { releaseCreditHold, settleCreditHold } from '../creditService/creditHold';

const logger = new Logger({ metadata: { test: 'settlement' } });
const run: CompletionRunAttribution = { runId: 'run-1', role: 'worker', purpose: 'tool', taskId: 'task-1' };
const creditHold: CreditHold = {
  ownerId: 'u1',
  ownerType: CreditHolderType.User,
  userId: 'u1',
  organizationId: null,
  reservedCredits: 300,
  balanceAfterHold: 700,
};
const entry = { type: 'generic_usage', model: 'test-video' } as unknown as CreditLedgerEntry;

const job = (overrides: Partial<IGenerationJobDocument> = {}) =>
  ({ id: 'job-1', kind: 'video', creditHold, ...overrides }) as IGenerationJobDocument;

const makeDeps = (budget?: ReturnType<typeof createFakeRunBudget>) => {
  const deps: JobSettlementDeps = {
    repository: { recordSettlement: vi.fn(async () => undefined) },
    credits: {} as CreditHoldAdapters,
    logger,
    ...(budget && { runBudget: budget.adapters }),
  };
  return deps;
};

const claimed = () => {
  const budget = createFakeRunBudget();
  budget.state.committedCredits = 300;
  return budget;
};

beforeEach(() => vi.clearAllMocks());

describe('settleJobHold with a run claim', () => {
  it('releases the claim down to the charge and tags the ledger row with the run', async () => {
    const budget = claimed();
    const deps = makeDeps(budget);
    const charged = await settleJobHold(
      job({ run, runClaim: { runId: 'run-1', credits: 300 } }),
      { credits: 120, entry, featureLabel: 'video generation' },
      deps
    );
    expect(charged).toBe(120);
    expect(settleCreditHold).toHaveBeenCalledWith(creditHold, 120, { ...entry, run }, expect.anything(), deps.credits);
    expect(budget.adapters.release).toHaveBeenCalledWith({ runId: 'run-1', credits: 300 }, 120);
    expect(budget.state.committedCredits).toBe(120);
    expect(deps.repository.recordSettlement).toHaveBeenCalledWith('job-1', 120);
  });

  it('logs, and still records the settlement, when the claim release fails', async () => {
    const budget = claimed();
    vi.mocked(budget.adapters.release).mockRejectedValue(new Error('run store down'));
    const deps = makeDeps(budget);
    const error = vi.spyOn(logger, 'error');
    await expect(
      settleJobHold(
        job({ run, runClaim: { runId: 'run-1', credits: 300 } }),
        { credits: 120, entry, featureLabel: 'video generation' },
        deps
      )
    ).resolves.toBe(120);
    expect(deps.repository.recordSettlement).toHaveBeenCalledWith('job-1', 120);
    expect(error).toHaveBeenCalledWith('generation_job_run_claim_release_failed', expect.anything());
  });

  it('tags an unbudgeted run on the ledger row without releasing anything', async () => {
    const budget = createFakeRunBudget();
    const deps = makeDeps(budget);
    await settleJobHold(job({ run }), { credits: 120, entry, featureLabel: 'video generation' }, deps);
    expect(settleCreditHold).toHaveBeenCalledWith(creditHold, 120, { ...entry, run }, expect.anything(), deps.credits);
    expect(budget.adapters.release).not.toHaveBeenCalled();
  });

  it('is unchanged without a run', async () => {
    const budget = createFakeRunBudget();
    const deps = makeDeps(budget);
    await settleJobHold(job(), { credits: 120, entry, featureLabel: 'video generation' }, deps);
    expect(settleCreditHold).toHaveBeenCalledWith(creditHold, 120, entry, expect.anything(), deps.credits);
    expect(budget.adapters.release).not.toHaveBeenCalled();
  });
});

describe('releaseJobHold with a run claim', () => {
  it('returns the whole claim with the hold', async () => {
    const budget = claimed();
    const deps = makeDeps(budget);
    await releaseJobHold(job({ run, runClaim: { runId: 'run-1', credits: 300 } }), deps);
    expect(releaseCreditHold).toHaveBeenCalledWith(creditHold, deps.credits);
    expect(budget.adapters.release).toHaveBeenCalledWith({ runId: 'run-1', credits: 300 }, 0);
    expect(budget.state.committedCredits).toBe(0);
    expect(deps.repository.recordSettlement).toHaveBeenCalledWith('job-1', 0);
  });

  it('reports a claim it cannot release when no run budget is wired', async () => {
    const deps = makeDeps();
    const error = vi.spyOn(logger, 'error');
    await releaseJobHold(job({ run, runClaim: { runId: 'run-1', credits: 300 } }), deps);
    expect(error).toHaveBeenCalledWith('generation_job_run_claim_release_failed', expect.anything());
    expect(deps.repository.recordSettlement).toHaveBeenCalledWith('job-1', 0);
  });
});
