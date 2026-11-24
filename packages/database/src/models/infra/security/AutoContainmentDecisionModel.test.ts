import { beforeEach, describe, expect, it } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import {
  AutoContainmentDecisionModel,
  autoContainmentDecisionRepository as repository,
  type RecordAutoContainmentDecisionInput,
} from './AutoContainmentDecisionModel';

const NOW = new Date('2026-11-05T10:00:00Z');
const MINUTE_MS = 60 * 1000;

const input = (over: Partial<RecordAutoContainmentDecisionInput> = {}): RecordAutoContainmentDecisionInput => ({
  detectionId: 'detection-1',
  revision: 0,
  assessmentId: 'assessment-1',
  mode: 'enforce',
  outcome: 'pending',
  userIds: ['user-1'],
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

describe('AutoContainmentDecisionRepository', () => {
  setupMongoTest();

  // The unique (detectionId, revision) index is what makes a claim exclusive; build it explicitly.
  beforeEach(async () => {
    await AutoContainmentDecisionModel.createIndexes();
  });

  it('records one decision per (detection, revision) and returns null for a duplicate', async () => {
    expect(await repository.recordOnce(input())).toMatchObject({ detectionId: 'detection-1', revision: 0 });
    expect(await repository.recordOnce(input({ assessmentId: 'assessment-2' }))).toBeNull();
    expect(await repository.recordOnce(input({ revision: 1, userIds: ['user-2'] }))).toMatchObject({ revision: 1 });

    const rows = await repository.listForDetection('detection-1');
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

    const done = await repository.recordOnce(input({ detectionId: 'detection-2' }));
    await repository.finish(done!.id, { outcome: 'contained', batchId: 'batch-1', error: null });
    expect(await repository.reclaim(done!.id, windows(new Date(NOW.getTime() + 24 * 60 * MINUTE_MS)))).toBeNull();
    expect((await repository.listForDetection('detection-2'))[0]).toMatchObject({
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
    });
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
    const byRevision = await repository.listForDetection('detection-1');
    expect(byRevision.map(d => d.outcome)).toEqual(['expired', 'intervened', 'contained']);
    expect(byRevision[0]).toMatchObject({ releasedAt: NOW, releaseCondition: 'expiry' });
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
