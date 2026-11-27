import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoReplSet, settleAutoIndexBuilds } from '../../../__test__/createMongoServer';
import { ShadowDetectionModel } from './ShadowDetectionModel';
import {
  AutoContainmentDecisionModel,
  autoContainmentDecisionRepository as repository,
  type RecordAutoContainmentDecisionInput,
} from './AutoContainmentDecisionModel';

const NOW = new Date('2026-11-05T10:00:00Z');
const MINUTE_MS = 60 * 1000;
const DETECTION_ID = new mongoose.Types.ObjectId().toHexString();
const SECOND_DETECTION_ID = new mongoose.Types.ObjectId().toHexString();
let server: Awaited<ReturnType<typeof createMongoReplSet>>;
beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false, monitorCommands: true });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

const input = (over: Partial<RecordAutoContainmentDecisionInput> = {}): RecordAutoContainmentDecisionInput => ({
  detectionId: DETECTION_ID,
  revision: 0,
  assessmentId: 'assessment-1',
  mode: 'enforce',
  outcome: 'pending',
  userIds: [`user-${(over.revision ?? 0) + 1}`],
  confidence: 0.97,
  reason: 'evidence',
  batchId: null,
  error: null,
  decidedAt: NOW,
  ...over,
});

const windows = (now: Date) => ({
  staleBefore: new Date(now.getTime() - 15 * MINUTE_MS),
  cappedBefore: new Date(now.getTime() - 60 * MINUTE_MS),
  now,
  mode: 'enforce' as const,
});

const deferred = () => {
  let resolve: () => void = () => {
    throw new Error('Deferred not initialized');
  };
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
};
async function waitForGate(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Expected competing claim write')), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function nextParentWrite() {
  const started = deferred();
  const client = mongoose.connection.getClient();
  const listener = (event: { commandName: string; command: Record<string, unknown> }) => {
    if (event.commandName !== 'update' || event.command.update !== 'ShadowDetection') return;
    client.off('commandStarted', listener);
    started.resolve();
  };
  client.on('commandStarted', listener);
  return started.promise;
}

describe('AutoContainmentDecisionRepository', () => {
  // The unique (detectionId, revision, claimClass) index is what makes a claim exclusive; build it explicitly.
  beforeEach(async () => {
    vi.restoreAllMocks();
    await AutoContainmentDecisionModel.deleteMany({});
    await ShadowDetectionModel.deleteMany({});
    await AutoContainmentDecisionModel.createIndexes();
    await ShadowDetectionModel.create(
      [DETECTION_ID, SECOND_DETECTION_ID].map(id => ({
        _id: new mongoose.Types.ObjectId(id),
        detector: 'youngAccountSpend',
        policyVersion: 1,
        wouldAction: 'contain',
        summary: 'Synthetic detection',
        userIds: ['user-1', 'user-2'],
        detectedAt: NOW,
      }))
    );
  });

  it('records one decision per detection revision and claim class and returns null for a duplicate', async () => {
    expect(await repository.recordOnce(input())).toMatchObject({ detectionId: DETECTION_ID, revision: 0 });
    expect(await repository.recordOnce(input({ assessmentId: 'assessment-2', userIds: ['new-member'] }))).toBeNull();
    expect(await repository.recordOnce(input({ revision: 1, userIds: ['user-2'] }))).toMatchObject({ revision: 1 });

    const rows = await repository.listForDetection(DETECTION_ID);
    expect(rows.map(row => row.revision)).toEqual([0, 1]);
  });

  it('reclaims a stale pending claim once, and leaves a fresh one alone', async () => {
    const row = await repository.recordOnce(input());
    expect(await repository.reclaim(row!.id, windows(new Date(NOW.getTime() + 5 * MINUTE_MS)))).toBeNull();

    const later = new Date(NOW.getTime() + 20 * MINUTE_MS);
    const [first, second] = await Promise.all([
      repository.reclaim(row!.id, windows(later)),
      repository.reclaim(row!.id, windows(later)),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first ?? second).toMatchObject({ outcome: 'pending', decidedAt: later });
  });

  it('reclaims capped after its hour and never a finished decision', async () => {
    const capped = await repository.recordOnce(input({ outcome: 'capped', mode: 'shadow' }));
    const later = new Date(NOW.getTime() + 61 * MINUTE_MS);
    expect(await repository.reclaim(capped!.id, windows(later))).toMatchObject({ outcome: 'pending', mode: 'enforce' });

    const done = await repository.recordOnce(input({ detectionId: SECOND_DETECTION_ID }));
    await repository.finish(done!.id, { outcome: 'contained', batchId: 'batch-1', error: null }, NOW);
    expect(await repository.reclaim(done!.id, windows(new Date(NOW.getTime() + 24 * 60 * MINUTE_MS)))).toBeNull();
    expect((await repository.listForDetection(SECOND_DETECTION_ID))[0]).toMatchObject({
      outcome: 'contained',
      batchId: 'batch-1',
    });
  });

  it('reads a row written before tiers existed as a Contain decision', async () => {
    const { insertedId } = await AutoContainmentDecisionModel.collection.insertOne({
      detectionId: 'legacy',
      revision: 0,
      assessmentId: 'assessment-1',
      mode: 'shadow',
      outcome: 'would_contain',
      userIds: ['user-1'],
      confidence: 0.95,
      reason: 'evidence',
      batchId: null,
      error: null,
      decidedAt: NOW,
    });
    const [legacy] = await repository.listForDetection('legacy');
    expect(legacy).toMatchObject({
      id: insertedId.toString(),
      tier: 'contain',
      policyVersion: null,
      scope: 'account',
      expiresAt: null,
      releasedAt: null,
      decidedBy: 'model',
      linkRules: [],
      modelJudgment: null,
    });
  });

  it('records a link-rule decision with the rules and the model judgment it overrode', async () => {
    const decision = await repository.recordOnce(
      input({
        tier: 'limit',
        policyVersion: 2,
        scope: 'ai_spend',
        expiresAt: new Date(NOW.getTime() + 60 * MINUTE_MS),
        decidedBy: 'link_rule',
        linkRules: ['sharedOwnedDomain'],
        modelJudgment: { result: 'insufficient_evidence', confidence: 0.6 },
      })
    );
    expect(decision).toMatchObject({
      decidedBy: 'link_rule',
      linkRules: ['sharedOwnedDomain'],
      modelJudgment: { result: 'insufficient_evidence', confidence: 0.6 },
    });
    const [stored] = await repository.listForDetection(DETECTION_ID);
    expect(stored).toMatchObject({ decidedBy: 'link_rule', linkRules: ['sharedOwnedDomain'] });
  });

  it('records a graduated decision with its tier fields', async () => {
    const expiresAt = new Date(NOW.getTime() + 72 * 60 * MINUTE_MS);
    const decision = await repository.recordOnce(
      input({ tier: 'review', policyVersion: 1, scope: 'ai_spend', expiresAt, outcome: 'would_intervene' })
    );
    expect(decision).toMatchObject({ tier: 'review', policyVersion: 1, scope: 'ai_spend', expiresAt });
  });

  it('releases an applied hold once, and never a shadow or Contain decision', async () => {
    const expiresAt = new Date(NOW.getTime() + 60 * MINUTE_MS);
    const applied = await repository.recordOnce(input({ tier: 'limit', expiresAt, outcome: 'intervened' }));
    const shadow = await repository.recordOnce(
      input({ revision: 1, tier: 'limit', expiresAt, outcome: 'would_intervene' })
    );
    const contained = await repository.recordOnce(input({ revision: 2, outcome: 'contained' }));
    const release = { by: 'admin-1', reason: 'cleared', condition: 'admin_release' as const, now: NOW };

    expect(await repository.release(applied!.id, release)).toMatchObject({
      outcome: 'released',
      releasedAt: NOW,
      releasedBy: 'admin-1',
      releaseReason: 'cleared',
      releaseCondition: 'admin_release',
    });
    expect(await repository.release(applied!.id, release)).toBeNull();
    expect(await repository.release(shadow!.id, release)).toBeNull();
    expect(await repository.release(contained!.id, release)).toBeNull();
    expect(await repository.release('not-an-id', release)).toBeNull();
  });

  it('marks only lapsed, unreleased applied holds expired', async () => {
    const lapsed = await repository.recordOnce(
      input({ tier: 'verify', expiresAt: new Date(NOW.getTime() - MINUTE_MS), outcome: 'intervened' })
    );
    const live = await repository.recordOnce(
      input({ revision: 1, tier: 'verify', expiresAt: new Date(NOW.getTime() + MINUTE_MS), outcome: 'intervened' })
    );
    const contained = await repository.recordOnce(input({ revision: 2, outcome: 'contained' }));

    expect(await repository.markExpired([lapsed!.id, live!.id, contained!.id, 'bad'], NOW)).toBe(1);
    expect(await repository.markExpired([lapsed!.id], NOW)).toBe(0);
    const byRevision = await repository.listForDetection(DETECTION_ID);
    expect(byRevision.map(d => d.outcome)).toEqual(['expired', 'intervened', 'contained']);
    expect(byRevision[0]).toMatchObject({ releasedAt: NOW, releaseCondition: 'expiry' });
  });

  it('rechecks Contain coverage when a graduated insertion follows an earlier empty snapshot', async () => {
    expect(await repository.listForDetection(DETECTION_ID)).toEqual([]);
    expect(await repository.recordOnce(input())).not.toBeNull();
    expect(await repository.recordOnce(input({ tier: 'limit' }))).toBeNull();
  });

  it.each(['contain', 'limit'] as const)(
    'serializes a %s claim before the competing class can insert',
    async firstTier => {
      const parent = mongoose.connection.collection('ShadowDetection');
      const nativeUpdate = parent.updateOne.bind(parent);
      const entered = deferred();
      const resume = deferred();
      vi.spyOn(parent, 'updateOne').mockImplementationOnce(async (...args) => {
        const result = await nativeUpdate(...args);
        entered.resolve();
        await resume.promise;
        return result;
      });
      const first = repository.recordOnce(input({ tier: firstTier }));
      await waitForGate(entered.promise);
      const started = nextParentWrite();
      const second = repository.recordOnce(input({ tier: firstTier === 'contain' ? 'limit' : 'contain' }));
      try {
        await waitForGate(started);
      } finally {
        resume.resolve();
      }
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).not.toBeNull();
      if (firstTier === 'contain') expect(secondResult).toBeNull();
      else {
        expect(secondResult).not.toBeNull();
        expect(await repository.listForDetection(DETECTION_ID)).toHaveLength(2);
      }
      const detection = await ShadowDetectionModel.findById(DETECTION_ID).lean();
      expect(detection?.revision).toBe(0);
    }
  );

  it('rolls back a failed fresh coverage read and rechecks on retry', async () => {
    const original = await ShadowDetectionModel.findById(DETECTION_ID).lean();
    vi.spyOn(AutoContainmentDecisionModel, 'find').mockImplementationOnce(() => {
      throw new Error('coverage unavailable');
    });
    await expect(repository.recordOnce(input({ tier: 'limit' }))).rejects.toThrow('coverage unavailable');
    expect(await AutoContainmentDecisionModel.countDocuments({})).toBe(0);
    expect((await ShadowDetectionModel.findById(DETECTION_ID).lean())?.holdClaimVersion).toBe(0);
    await repository.recordOnce(input());
    expect(await repository.recordOnce(input({ tier: 'limit' }))).toBeNull();
    const after = await ShadowDetectionModel.findById(DETECTION_ID).lean();
    expect(after?.updatedAt).toEqual(original?.updatedAt);
    expect(after?.revision).toBe(original?.revision);
  });

  it('keeps only the uncovered part of the original input cohort', async () => {
    await repository.recordOnce(input());
    const remaining = await repository.recordOnce(input({ tier: 'limit', userIds: ['user-1', 'user-2'] }));
    expect(remaining).toMatchObject({ tier: 'limit', userIds: ['user-2'] });
  });

  it('does not create an orphan decision when the detection disappeared', async () => {
    await ShadowDetectionModel.deleteOne({ _id: DETECTION_ID });
    expect(await repository.recordOnce(input())).toBeNull();
    expect(await AutoContainmentDecisionModel.countDocuments({})).toBe(0);
  });

  it('admits only one graduated tier when different tiers claim the same revision concurrently', async () => {
    const rows = await Promise.all([
      repository.recordOnce(input({ tier: 'limit' })),
      repository.recordOnce(input({ tier: 'review' })),
    ]);
    expect(rows.filter(Boolean)).toHaveLength(1);
    expect(await repository.recordOnce(input({ tier: 'contain' }))).not.toBeNull();
  });

  it('keeps original graduated provenance when Contain claims the same revision', async () => {
    const limit = await repository.recordOnce(
      input({ tier: 'limit', outcome: 'intervened', expiresAt: NOW, policyVersion: 1, scope: 'ai_spend' })
    );
    const [first, second] = await Promise.all([
      repository.recordOnce(input({ assessmentId: 'contain-1' })),
      repository.recordOnce(input({ assessmentId: 'contain-2' })),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((first ?? second)?.id).not.toBe(limit!.id);
    expect(await repository.findById(limit!.id)).toEqual(limit);
    expect(
      await repository.release(limit!.id, { by: 'admin-1', reason: 'cleared', condition: 'admin_release', now: NOW })
    ).toMatchObject({ tier: 'limit', outcome: 'released', expiresAt: NOW, policyVersion: 1 });
  });

  it('rejects stale completion after reclaim or release', async () => {
    const row = await repository.recordOnce(input({ tier: 'limit' }));
    const later = new Date(NOW.getTime() + 20 * MINUTE_MS);
    await repository.reclaim(row!.id, windows(later));
    const patch = { outcome: 'intervened' as const, batchId: null, error: null };
    expect(await repository.finish(row!.id, patch, NOW)).toBe(false);
    expect(await repository.finish(row!.id, patch, later)).toBe(true);
    await repository.release(row!.id, { by: 'admin', reason: 'cleared', condition: 'admin_release', now: later });
    expect(await repository.finish(row!.id, patch, later)).toBe(false);
    expect(await repository.findById(row!.id)).toMatchObject({
      outcome: 'released',
      releaseCondition: 'admin_release',
    });
  });

  it('finds a decision by id and lists applied, unreleased decisions of one tier oldest first', async () => {
    const first = await repository.recordOnce(input({ tier: 'limit', outcome: 'intervened' }));
    const second = await repository.recordOnce(input({ revision: 1, tier: 'limit', outcome: 'intervened' }));
    await repository.recordOnce(input({ revision: 2, tier: 'review', outcome: 'intervened' }));
    await repository.recordOnce(input({ revision: 3, tier: 'limit', outcome: 'would_intervene' }));
    await repository.release(first!.id, { by: 'admin-1', reason: 'cleared', condition: 'admin_release', now: NOW });

    expect((await repository.findById(second!.id))?.revision).toBe(1);
    expect(await repository.findById('bad')).toBeNull();
    expect((await repository.listActiveByTier('limit', 10)).map(d => d.id)).toEqual([second!.id]);
  });
});
