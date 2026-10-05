import { beforeEach, describe, expect, it } from 'vitest';
import { CreditHolderType, type IGenerationJob } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import { GenerationJobModel, generationJobRepository } from './GenerationJobModel';

const t0 = new Date('2026-10-06T00:00:00Z');
const plus = (ms: number) => new Date(t0.getTime() + ms);

const newJob = (overrides: Partial<IGenerationJob> = {}): Omit<IGenerationJob, 'createdAt' | 'updatedAt'> => ({
  kind: 'video',
  ownerType: CreditHolderType.User,
  ownerId: 'u1',
  requestedBy: 'u1',
  source: 'studio',
  state: 'pending',
  payload: {
    request: {
      model: 'test-video',
      mode: 'text_to_video',
      prompt: 'p',
      durationSeconds: 4,
      aspectRatio: '16:9',
      resolution: '720p',
    },
    providerId: 'test',
  },
  pollCount: 0,
  attempts: 0,
  cancelRequested: false,
  deadlineAt: plus(20 * 60_000),
  creditHold: null,
  ...overrides,
});

describe('GenerationJobRepository', () => {
  setupMongoTest();
  // setupMongoTest drops the database between tests, indexes included.
  beforeEach(async () => {
    await GenerationJobModel.ensureIndexes();
  });

  it('acquires a lease on a non-terminal job', async () => {
    const job = await generationJobRepository.createJob(newJob());
    const leased = await generationJobRepository.acquireLease(job.id, t0, plus(330_000));
    expect(leased?.id).toBe(job.id);
  });

  it('a second acquireLease while leased returns null', async () => {
    const job = await generationJobRepository.createJob(newJob());
    await generationJobRepository.acquireLease(job.id, t0, plus(330_000));
    expect(await generationJobRepository.acquireLease(job.id, plus(1_000), plus(331_000))).toBeNull();
  });

  it('re-acquires once the lease has expired', async () => {
    const job = await generationJobRepository.createJob(newJob());
    await generationJobRepository.acquireLease(job.id, t0, plus(330_000));
    expect(await generationJobRepository.acquireLease(job.id, plus(331_000), plus(661_000))).not.toBeNull();
  });

  it('commit clears the lease so the next step can run immediately', async () => {
    const job = await generationJobRepository.createJob(newJob());
    await generationJobRepository.acquireLease(job.id, t0, plus(330_000));
    await generationJobRepository.commit(job.id, { state: 'running' });
    expect(await generationJobRepository.acquireLease(job.id, plus(1_000), plus(331_000))).not.toBeNull();
  });

  it('does not lease a terminal job whose terminal handling is done', async () => {
    const job = await generationJobRepository.createJob(newJob({ state: 'succeeded', terminalHandledAt: t0 }));
    expect(await generationJobRepository.acquireLease(job.id, t0, plus(330_000))).toBeNull();
  });

  it('leases a terminal job whose terminal handling never completed', async () => {
    const job = await generationJobRepository.createJob(newJob({ state: 'failed', terminalHandledAt: null }));
    expect(await generationJobRepository.acquireLease(job.id, t0, plus(330_000))).not.toBeNull();
  });

  it('claimTerminalHandling succeeds exactly once', async () => {
    const job = await generationJobRepository.createJob(newJob({ state: 'succeeded' }));
    expect(await generationJobRepository.claimTerminalHandling(job.id, t0)).toBe(true);
    expect(await generationJobRepository.claimTerminalHandling(job.id, plus(1))).toBe(false);
  });

  it('enforces one idempotency key per owner', async () => {
    await generationJobRepository.createJob(newJob({ idempotencyKey: 'k1' }));
    await expect(generationJobRepository.createJob(newJob({ idempotencyKey: 'k1' }))).rejects.toMatchObject({
      code: 11000,
    });
    await expect(
      generationJobRepository.createJob(newJob({ idempotencyKey: 'k1', ownerId: 'u2' }))
    ).resolves.toBeTruthy();
  });

  it('findStalled returns overdue non-terminal jobs and unhandled, unclaimed terminal jobs', async () => {
    const overdue = await generationJobRepository.createJob(newJob({ state: 'running', nextPollAt: t0 }));
    await generationJobRepository.createJob(newJob({ state: 'running', nextPollAt: plus(10 * 60_000) }));
    const unhandled = await generationJobRepository.createJob(newJob({ state: 'succeeded', terminalHandledAt: null }));
    await GenerationJobModel.updateOne({ _id: unhandled.id }, { $set: { updatedAt: t0 } }, { timestamps: false });
    const ids = (await generationJobRepository.findStalled(plus(60_000), 50)).map(j => j.id).sort();
    expect(ids).toEqual([overdue.id, unhandled.id].sort());
  });

  it('hides rawProviderError by default', async () => {
    const job = await generationJobRepository.createJob(newJob());
    await generationJobRepository.commit(job.id, { rawProviderError: { secret: 'provider payload' } });
    const found = await generationJobRepository.findById(job.id);
    expect((found as Record<string, unknown>).rawProviderError).toBeUndefined();
    const stored = await GenerationJobModel.findById(job.id).select('+rawProviderError');
    expect(stored?.rawProviderError).toEqual({ secret: 'provider payload' });
  });
});
