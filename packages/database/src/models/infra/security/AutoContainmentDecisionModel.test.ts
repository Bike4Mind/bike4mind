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
});
