import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { CreditHolderType, type IGenerationJob } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import { GenerationJobModel, generationJobRepository } from './GenerationJobModel';

const t0 = new Date('2026-10-06T00:00:00Z');
const plus = (ms: number) => new Date(t0.getTime() + ms);
const lease = (leaseToken: Date) => ({ kind: 'lease' as const, leaseToken });

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

  it('persists a job under a caller-supplied id', async () => {
    const id = new mongoose.Types.ObjectId().toHexString();
    const job = await generationJobRepository.createJob({ ...newJob(), id });
    expect(job.id).toBe(id);
    expect((await generationJobRepository.findById(id))?.ownerId).toBe('u1');
  });

  it('rejects a supplied id that is not a lowercase 24-hex ObjectId string', async () => {
    const upper = new mongoose.Types.ObjectId().toHexString().toUpperCase();
    for (const id of ['job1', '', upper]) {
      await expect(generationJobRepository.createJob({ ...newJob(), id })).rejects.toThrow(/24-hex/);
    }
    expect(await GenerationJobModel.countDocuments()).toBe(0);
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
    await generationJobRepository.commit(job.id, { state: 'running' }, lease(plus(330_000)));
    expect(await generationJobRepository.acquireLease(job.id, plus(1_000), plus(331_000))).not.toBeNull();
  });

  it('rejects the commit of a worker whose expired lease was taken over by a second worker', async () => {
    const job = await generationJobRepository.createJob(newJob());
    const firstToken = plus(330_000);
    await generationJobRepository.acquireLease(job.id, t0, firstToken);
    const secondToken = plus(331_000 + 330_000);
    expect(await generationJobRepository.acquireLease(job.id, plus(331_000), secondToken)).not.toBeNull();

    expect(await generationJobRepository.commit(job.id, { state: 'failed' }, lease(firstToken))).toBeNull();
    const afterStale = await generationJobRepository.findById(job.id);
    expect(afterStale?.state).toBe('pending');
    expect(afterStale?.leaseUntil).toEqual(secondToken);

    expect(await generationJobRepository.commit(job.id, { state: 'running' }, lease(secondToken))).toMatchObject({
      state: 'running',
      leaseUntil: null,
    });
  });

  describe('an unstarted commit', () => {
    const unstarted = { kind: 'unstarted' as const, now: t0 };
    const failed = { state: 'failed' as const, error: { code: 'enqueue_failed' as const, message: 'x' } };

    it('applies to a pending job no worker has touched', async () => {
      const job = await generationJobRepository.createJob(newJob());
      expect(await generationJobRepository.commit(job.id, failed, unstarted)).toMatchObject({ state: 'failed' });
    });

    it('applies once a crashed worker lease has expired without a submit', async () => {
      const job = await generationJobRepository.createJob(newJob({ leaseUntil: plus(-1_000) }));
      expect(await generationJobRepository.commit(job.id, failed, unstarted)).toMatchObject({ state: 'failed' });
    });

    it('is rejected once a worker holds the lease, submitted, or advanced the job', async () => {
      const leased = await generationJobRepository.createJob(newJob());
      await generationJobRepository.acquireLease(leased.id, t0, plus(330_000));
      const submitted = await generationJobRepository.createJob(newJob({ submitAttemptedAt: t0 }));
      const running = await generationJobRepository.createJob(newJob({ state: 'running' }));
      for (const job of [leased, submitted, running]) {
        expect(await generationJobRepository.commit(job.id, failed, unstarted)).toBeNull();
      }
      expect(await GenerationJobModel.countDocuments({ state: 'failed' })).toBe(0);
    });
  });

  it('recordSettlement writes the settled credits whatever the lease state', async () => {
    const job = await generationJobRepository.createJob(newJob({ state: 'succeeded' }));
    await generationJobRepository.acquireLease(job.id, t0, plus(330_000));
    await generationJobRepository.recordSettlement(job.id, 12);
    expect(await generationJobRepository.findById(job.id)).toMatchObject({
      settledCredits: 12,
      leaseUntil: plus(330_000),
    });
  });

  it('rejects a commit once the lease it carried was already released', async () => {
    const job = await generationJobRepository.createJob(newJob());
    await generationJobRepository.acquireLease(job.id, t0, plus(330_000));
    await generationJobRepository.commit(job.id, { state: 'running' }, lease(plus(330_000)));
    expect(await generationJobRepository.commit(job.id, { state: 'failed' }, lease(plus(330_000)))).toBeNull();
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
    await generationJobRepository.acquireLease(job.id, t0, plus(330_000));
    await generationJobRepository.commit(
      job.id,
      { rawProviderError: { secret: 'provider payload' } },
      lease(plus(330_000))
    );
    const found = await generationJobRepository.findById(job.id);
    expect((found as Record<string, unknown>).rawProviderError).toBeUndefined();
    const stored = await GenerationJobModel.findById(job.id).select('+rawProviderError');
    expect(stored?.rawProviderError).toEqual({ secret: 'provider payload' });
  });

  describe('findStalled for terminal jobs', () => {
    const cutoff = plus(60_000);
    const terminal = (overrides: Partial<IGenerationJob>) =>
      generationJobRepository.createJob(newJob({ state: 'succeeded', terminalHandledAt: null, ...overrides }));
    const setUpdatedAt = (id: string, updatedAt: Date) =>
      GenerationJobModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { updatedAt } });

    it('returns a job claimed before the cutoff and never handled', async () => {
      const stuck = await terminal({ terminalHandlingClaimedAt: t0 });
      expect((await generationJobRepository.findStalled(cutoff, 50)).map(j => j.id)).toEqual([stuck.id]);
    });

    it('skips claimed-after-cutoff, handled and recently updated unclaimed terminal jobs', async () => {
      await terminal({ terminalHandlingClaimedAt: plus(120_000) });
      await terminal({ terminalHandlingClaimedAt: t0, terminalHandledAt: t0 });
      const fresh = await terminal({});
      await setUpdatedAt(fresh.id, plus(120_000));
      expect(await generationJobRepository.findStalled(cutoff, 50)).toEqual([]);
    });

    it('returns an unclaimed terminal job once it is older than the cutoff', async () => {
      const old = await terminal({});
      await setUpdatedAt(old.id, t0);
      expect((await generationJobRepository.findStalled(cutoff, 50)).map(j => j.id)).toEqual([old.id]);
    });
  });

  it('requestCancel flags only pending and running jobs', async () => {
    for (const state of ['pending', 'running'] as const) {
      const job = await generationJobRepository.createJob(newJob({ state }));
      expect(await generationJobRepository.requestCancel(job.id)).toMatchObject({ cancelRequested: true });
    }
    for (const state of ['storing', 'succeeded', 'cancelled'] as const) {
      const job = await generationJobRepository.createJob(newJob({ state }));
      expect(await generationJobRepository.requestCancel(job.id)).toBeNull();
      expect((await generationJobRepository.findById(job.id))?.cancelRequested).toBe(false);
    }
  });

  it('findStalled returns in-flight jobs by nextPollAt before terminal jobs by updatedAt, within the limit', async () => {
    const setUpdatedAt = (id: string, updatedAt: Date) =>
      GenerationJobModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { updatedAt } });
    // Stuck-claimed terminal jobs older than every in-flight one: they must not crowd the in-flight jobs out.
    for (let i = 0; i < 3; i++) {
      const stuck = await generationJobRepository.createJob(
        newJob({ state: 'failed', terminalHandledAt: null, terminalHandlingClaimedAt: plus(-120_000) })
      );
      await setUpdatedAt(stuck.id, plus(-120_000 + i));
    }
    const later = await generationJobRepository.createJob(newJob({ state: 'running', nextPollAt: plus(-10_000) }));
    const earlier = await generationJobRepository.createJob(newJob({ state: 'running', nextPollAt: plus(-20_000) }));
    const unclaimed = await generationJobRepository.createJob(newJob({ state: 'succeeded', terminalHandledAt: null }));
    await setUpdatedAt(unclaimed.id, plus(-600_000));

    expect((await generationJobRepository.findStalled(t0, 2)).map(j => j.id)).toEqual([earlier.id, later.id]);
    expect((await generationJobRepository.findStalled(t0, 3)).map(j => j.id)).toEqual([
      earlier.id,
      later.id,
      unclaimed.id,
    ]);
  });

  it('concurrent acquireLease calls yield exactly one winner', async () => {
    const job = await generationJobRepository.createJob(newJob());
    const results = await Promise.all([
      generationJobRepository.acquireLease(job.id, t0, plus(330_000)),
      generationJobRepository.acquireLease(job.id, t0, plus(330_000)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('findByIdempotencyKey round-trips', async () => {
    const job = await generationJobRepository.createJob(newJob({ idempotencyKey: 'k9' }));
    const found = await generationJobRepository.findByIdempotencyKey(CreditHolderType.User, 'u1', 'k9');
    expect(found?.id).toBe(job.id);
    expect(await generationJobRepository.findByIdempotencyKey(CreditHolderType.User, 'u1', 'nope')).toBeNull();
  });
});
