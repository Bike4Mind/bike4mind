import { describe, it, expect, beforeEach } from 'vitest';
import { lakeConfigUndoClaimRepository as repo, LakeConfigUndoClaimModel } from './LakeConfigUndoClaimModel';
import { setupMongoTest } from '../../__test__/utils';

describe('LakeConfigUndoClaimRepository', () => {
  setupMongoTest();
  beforeEach(async () => {
    await LakeConfigUndoClaimModel.ensureIndexes();
  });

  it('grants a claim once per event and lake', async () => {
    expect(await repo.claim('lake-1', 'evt-1', 'undo-1')).toBe(true);
    expect(await repo.claim('lake-1', 'evt-1', 'undo-2')).toBe(false);
    expect(await repo.claim('lake-2', 'evt-1')).toBe(true);
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const results = await Promise.all([repo.claim('lake-1', 'evt-1'), repo.claim('lake-1', 'evt-1')]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('can be claimed again after a release', async () => {
    await repo.claim('lake-1', 'evt-1');
    await repo.release('lake-1', 'evt-1');
    expect(await repo.claim('lake-1', 'evt-1')).toBe(true);
  });

  it('lists the claims for a set of events, scoped to the lake', async () => {
    await repo.claim('lake-1', 'evt-1', 'undo-1');
    await repo.claim('lake-1', 'evt-2');
    await repo.claim('lake-2', 'evt-3');

    const claims = await repo.listForEvents('lake-1', ['evt-1', 'evt-3']);

    expect(claims.map(c => [c.eventId, c.undoEventId])).toEqual([['evt-1', 'undo-1']]);
  });

  it('has no TTL, because the claim is the only record that an event was undone', async () => {
    const indexes = await LakeConfigUndoClaimModel.collection.indexes();
    expect(indexes.some(i => i.expireAfterSeconds !== undefined)).toBe(false);
    expect(indexes.find(i => i.key.dataLakeId === 1 && i.key.eventId === 1)?.unique).toBe(true);
  });

  it('deleteForLake removes only that lake', async () => {
    await repo.claim('lake-1', 'evt-1');
    await repo.claim('lake-1', 'evt-2');
    await repo.claim('lake-2', 'evt-1');
    expect(await repo.deleteForLake('lake-1')).toBe(2);
    expect(await repo.listForEvents('lake-2', ['evt-1'])).toHaveLength(1);
  });
});
