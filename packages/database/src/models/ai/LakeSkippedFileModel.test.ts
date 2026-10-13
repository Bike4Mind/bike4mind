import { describe, it, expect, beforeEach } from 'vitest';
import type { LakeSkippedFileInput } from '@bike4mind/common';
import { lakeSkippedFileRepository as repo, LakeSkippedFileModel } from './LakeSkippedFileModel';
import { setupMongoTest } from '../../__test__/utils';

const skip = (overrides: Partial<LakeSkippedFileInput> = {}): LakeSkippedFileInput => ({
  dataLakeId: 'lake-1',
  sourceKind: 'google_drive',
  sourceId: 'drive-1',
  name: 'form.gform',
  relativePath: 'surveys/form.gform',
  mimeType: 'application/vnd.google-apps.form',
  reason: 'unsupported',
  ...overrides,
});

const rows = (dataLakeId = 'lake-1') => repo.listByLake(dataLakeId, { limit: 100, offset: 0 });

describe('LakeSkippedFileRepository', () => {
  setupMongoTest();
  // setupMongoTest's beforeEach dropDatabase()s (indexes included) - rebuild the unique index so the
  // idempotency cases exercise it.
  beforeEach(async () => {
    await LakeSkippedFileModel.ensureIndexes();
  });

  it('a repeat skip refreshes the one row in place, keeping firstSeenAt', async () => {
    await repo.recordSkip(skip({ reason: 'storage_limit', size: 10 }));
    const [first] = await rows();

    await repo.recordSkip(skip({ reason: 'exceeds_max_file_size', size: undefined }));
    const all = await rows();

    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first.id);
    expect(all[0].reason).toBe('exceeds_max_file_size');
    expect(all[0].size).toBeUndefined();
    expect(all[0].firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
    expect(all[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
  });

  it('recordSkips upserts a whole set in one call, idempotently', async () => {
    const set = [skip({ sourceId: 'a' }), skip({ sourceId: 'b', reason: 'storage_limit' })];
    await repo.recordSkips(set);
    await repo.recordSkips(set);

    expect((await rows()).map(row => row.sourceId).sort()).toEqual(['a', 'b']);
    await expect(repo.recordSkips([])).resolves.toBeUndefined();
  });

  it('enforces one row per (lake, source, id) via the unique index', async () => {
    await repo.recordSkip(skip());
    const now = new Date();
    await expect(LakeSkippedFileModel.create({ ...skip(), firstSeenAt: now, lastSeenAt: now })).rejects.toThrow(
      /duplicate key|E11000/i
    );
  });

  it('keeps the same source id distinct across lakes and source kinds', async () => {
    await repo.recordSkip(skip());
    await repo.recordSkip(skip({ dataLakeId: 'lake-2' }));
    await repo.recordSkip(skip({ sourceKind: 'github', reason: 'binary' }));

    expect(await repo.countByLake('lake-1')).toBe(2);
    expect(await repo.countByLake('lake-2')).toBe(1);
  });

  it('rejects a reason outside the shared enum', async () => {
    await expect(repo.recordSkip(skip({ reason: 'rate_limited' as LakeSkippedFileInput['reason'] }))).rejects.toThrow();
  });

  it('clearSources removes only the named ids for that lake and source', async () => {
    await repo.recordSkip(skip({ sourceId: 'a' }));
    await repo.recordSkip(skip({ sourceId: 'b' }));
    await repo.recordSkip(skip({ sourceId: 'a', sourceKind: 'github', reason: 'binary' }));

    expect(await repo.clearSources('lake-1', 'google_drive', ['a'])).toBe(1);
    expect(await repo.clearSources('lake-1', 'google_drive', [])).toBe(0);

    const left = (await rows()).map(row => `${row.sourceKind}:${row.sourceId}`).sort();
    expect(left).toEqual(['github:a', 'google_drive:b']);
  });

  it('pruneMissing drops rows whose file is no longer in the source', async () => {
    await repo.recordSkip(skip({ sourceId: 'kept' }));
    await repo.recordSkip(skip({ sourceId: 'gone' }));
    await repo.recordSkip(skip({ sourceId: 'gone', sourceKind: 'github', reason: 'binary' }));

    expect(await repo.pruneMissing('lake-1', 'google_drive', new Set(['kept', 'unrelated']))).toBe(1);

    const left = (await rows()).map(row => `${row.sourceKind}:${row.sourceId}`).sort();
    expect(left).toEqual(['github:gone', 'google_drive:kept']);
  });

  it('pages most-recently-first-skipped first while the count covers every row', async () => {
    for (const sourceId of ['a', 'b', 'c']) {
      await repo.recordSkip(skip({ sourceId }));
    }
    const page = await repo.listByLake('lake-1', { limit: 2, offset: 0 });
    const rest = await repo.listByLake('lake-1', { limit: 2, offset: 2 });

    expect(page.map(row => row.sourceId)).toEqual(['c', 'b']);
    expect(rest.map(row => row.sourceId)).toEqual(['a']);
    expect(await repo.countByLake('lake-1')).toBe(3);
  });

  it('keeps page order stable when a re-skip refreshes a row between page loads', async () => {
    for (const sourceId of ['a', 'b', 'c']) {
      await repo.recordSkip(skip({ sourceId }));
    }
    const page = await repo.listByLake('lake-1', { limit: 2, offset: 0 });
    // A full walk re-skips the oldest row, refreshing its lastSeenAt.
    await repo.recordSkip(skip({ sourceId: 'a' }));
    const rest = await repo.listByLake('lake-1', { limit: 2, offset: 2 });

    expect([...page, ...rest].map(row => row.sourceId)).toEqual(['c', 'b', 'a']);
  });

  it('deleteForSource and deleteForLake scope their sweep', async () => {
    await repo.recordSkip(skip({ sourceId: 'a' }));
    await repo.recordSkip(skip({ sourceId: 'b', sourceKind: 'github', reason: 'binary' }));
    await repo.recordSkip(skip({ dataLakeId: 'lake-2' }));

    expect(await repo.deleteForSource('lake-1', 'github')).toBe(1);
    expect(await repo.deleteForLake('lake-1')).toBe(1);
    expect(await repo.countByLake('lake-2')).toBe(1);
  });
});
