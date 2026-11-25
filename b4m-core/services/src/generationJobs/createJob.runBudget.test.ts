import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, insufficientCreditsError, type CompletionRunAttribution } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import type { CreditHold, CreditHoldAdapters } from '../creditService/creditHold';
import { createFakeRunBudget } from './__test__/fakeRunBudget';
import { createInMemoryGenerationJobRepository } from './__test__/inMemoryGenerationJobRepository';
import { holdJobCredits, persistAndEnqueueJob, type CreateGenerationJobDeps } from './createJob';

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
}));
import { holdCredits, releaseCreditHold } from '../creditService/creditHold';

const logger = new Logger({ metadata: { test: 'createJob.runBudget' } });
const credits = { spendFreezes: { findActiveForSubject: vi.fn(async () => null) } } as unknown as CreditHoldAdapters;
const user = { id: 'u1', organizationId: null };
const run: CompletionRunAttribution = { runId: 'run-1', role: 'worker', purpose: 'tool' };

const fakeHold = (requiredCredits: number): CreditHold => ({
  ownerId: 'u1',
  ownerType: CreditHolderType.User,
  userId: 'u1',
  organizationId: null,
  reservedCredits: requiredCredits,
  balanceAfterHold: 1000,
});

const hold = (overrides: { run?: CompletionRunAttribution; enforceCredits?: boolean } = {}) => ({
  enforceCredits: overrides.enforceCredits ?? true,
  user,
  requiredCredits: 300,
  featureLabel: 'video generation',
  ...(overrides.run && { run: overrides.run }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(holdCredits).mockImplementation(async params => fakeHold(params.requiredCredits));
});

describe('holdJobCredits with a run', () => {
  it('claims the whole hold against the run inside one transaction', async () => {
    const budget = createFakeRunBudget();
    const held = await holdJobCredits(hold({ run }), { credits, logger, runBudget: budget.adapters });
    expect(held).toEqual({ ok: true, hold: fakeHold(300), runClaim: { runId: 'run-1', credits: 300 } });
    expect(budget.adapters.claim).toHaveBeenCalledWith('run-1', 300);
    expect(budget.adapters.transact).toHaveBeenCalledTimes(1);
    expect(budget.state.committedCredits).toBe(300);
  });

  it('refuses with run_budget_exhausted before any hold when the job does not fit', async () => {
    const budget = createFakeRunBudget({ budgetCredits: 299 });
    await expect(holdJobCredits(hold({ run }), { credits, logger, runBudget: budget.adapters })).rejects.toMatchObject({
      additionalInfo: { errorCode: 'run_budget_exhausted' },
    });
    expect(holdCredits).not.toHaveBeenCalled();
    expect(budget.state.committedCredits).toBe(0);
  });

  it('returns the claim when the hold is refused for insufficient credits', async () => {
    const budget = createFakeRunBudget();
    vi.mocked(holdCredits).mockRejectedValue(insufficientCreditsError('Not enough credits'));
    const held = await holdJobCredits(hold({ run }), { credits, logger, runBudget: budget.adapters });
    expect(held).toMatchObject({ ok: false, status: 402, code: 'insufficient_credits' });
    expect(budget.state.committedCredits).toBe(0);
  });

  it('returns the claim when the hold throws', async () => {
    const budget = createFakeRunBudget();
    vi.mocked(holdCredits).mockRejectedValue(new Error('balance write failed'));
    await expect(holdJobCredits(hold({ run }), { credits, logger, runBudget: budget.adapters })).rejects.toThrow(
      'balance write failed'
    );
    expect(budget.state.committedCredits).toBe(0);
  });

  it('claims nothing when credits are not enforced', async () => {
    const budget = createFakeRunBudget();
    const held = await holdJobCredits(hold({ run, enforceCredits: false }), {
      credits,
      logger,
      runBudget: budget.adapters,
    });
    expect(held).toEqual({ ok: true, hold: null });
    expect(budget.adapters.claim).not.toHaveBeenCalled();
  });

  it('carries no claim for an unbudgeted run', async () => {
    const budget = createFakeRunBudget({ runId: 'another-run' });
    const held = await holdJobCredits(hold({ run }), { credits, logger, runBudget: budget.adapters });
    expect(held).toEqual({ ok: true, hold: fakeHold(300) });
  });

  it('fails loudly when a run arrives without run budget adapters', async () => {
    await expect(holdJobCredits(hold({ run }), { credits, logger })).rejects.toThrow(/run budget/);
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('is unchanged without a run', async () => {
    const budget = createFakeRunBudget();
    const held = await holdJobCredits(hold(), { credits, logger, runBudget: budget.adapters });
    expect(held).toEqual({ ok: true, hold: fakeHold(300) });
    expect(budget.adapters.transact).not.toHaveBeenCalled();
    expect(budget.adapters.claim).not.toHaveBeenCalled();
  });
});

describe('persistAndEnqueueJob with a run claim', () => {
  const makeDeps = (budget: ReturnType<typeof createFakeRunBudget>) => {
    const repository = createInMemoryGenerationJobRepository();
    const deps: CreateGenerationJobDeps = {
      repository,
      credits,
      enqueue: vi.fn(async () => undefined),
      engine: { failBeforeStart: vi.fn(async () => 'failed' as const) },
      logger,
      runBudget: budget.adapters,
    };
    return { deps, repository };
  };

  const newJob = (runClaim: { runId: string; credits: number }) => ({
    ownerType: CreditHolderType.User as const,
    ownerId: 'u1',
    requestedBy: 'u1',
    source: 'api' as const,
    state: 'pending' as const,
    payload: {
      request: {
        model: 'test-video' as const,
        mode: 'text_to_video' as const,
        prompt: 'a cat',
        durationSeconds: 4,
        aspectRatio: '16:9' as const,
        resolution: '720p' as const,
      },
      providerId: 'test' as const,
    },
    pollCount: 0,
    attempts: 0,
    cancelRequested: false,
    deadlineAt: new Date('2026-10-06T01:00:00Z'),
    creditHold: fakeHold(300),
    run,
    runClaim,
  });

  it('persists the claim and the run on the job', async () => {
    const budget = createFakeRunBudget();
    const { deps } = makeDeps(budget);
    const created = await persistAndEnqueueJob('video', newJob({ runId: 'run-1', credits: 300 }), deps);
    expect(created).toMatchObject({ ok: true, job: { run, runClaim: { runId: 'run-1', credits: 300 } } });
    expect(budget.adapters.release).not.toHaveBeenCalled();
  });

  it('returns the whole claim with the hold when the create is confirmed absent', async () => {
    const budget = createFakeRunBudget();
    budget.state.committedCredits = 300;
    const { deps, repository } = makeDeps(budget);
    vi.spyOn(repository, 'createJob').mockRejectedValue(new Error('primary stepped down'));
    await expect(persistAndEnqueueJob('video', newJob({ runId: 'run-1', credits: 300 }), deps)).rejects.toThrow(
      'primary stepped down'
    );
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(budget.adapters.release).toHaveBeenCalledWith({ runId: 'run-1', credits: 300 }, 0);
    expect(budget.state.committedCredits).toBe(0);
  });

  it('keeps the claim with the hold when the create outcome is unknown', async () => {
    const budget = createFakeRunBudget();
    const { deps, repository } = makeDeps(budget);
    vi.spyOn(repository, 'createJob').mockRejectedValue(new Error('lost ack'));
    vi.spyOn(repository, 'findById').mockRejectedValue(new Error('lookup failed'));
    await expect(persistAndEnqueueJob('video', newJob({ runId: 'run-1', credits: 300 }), deps)).rejects.toThrow(
      'lost ack'
    );
    expect(releaseCreditHold).not.toHaveBeenCalled();
    expect(budget.adapters.release).not.toHaveBeenCalled();
  });
});
