import { describe, it, expect, beforeEach } from 'vitest';
import type { IDataLakeCorpusAction } from '@bike4mind/common';
import { dataLakeCorpusActionRepository as repo, DataLakeCorpusActionModel } from './DataLakeCorpusActionModel';
import { setupMongoTest } from '../../__test__/utils';

const event = (overrides: Partial<IDataLakeCorpusAction> = {}): IDataLakeCorpusAction => ({
  lakeId: 'lake-1',
  findingId: 'finding-1',
  action: 'merge',
  targets: [
    { fabFileId: 'doc-a', fileName: 'a.md', role: 'kept' },
    { fabFileId: 'doc-b', fileName: 'b.md', role: 'retired' },
  ],
  detail: { removedFabFileIds: ['doc-b'] },
  note: null,
  actorUserId: 'curator-1',
  principal: { principalKind: 'user', principalId: 'curator-1' },
  rung: 'creator',
  at: new Date('2026-09-01T00:00:00Z'),
  ...overrides,
});

describe('DataLakeCorpusActionRepository', () => {
  setupMongoTest();

  // setupMongoTest drops the whole database between tests, and indexes go with it.
  beforeEach(async () => {
    await DataLakeCorpusActionModel.ensureIndexes();
  });

  it('persists a row through record', async () => {
    const stored = await repo.record(event());

    expect(stored.lakeId).toBe('lake-1');
    expect(stored.findingId).toBe('finding-1');
    expect(stored.action).toBe('merge');
    expect(stored.targets).toEqual([
      { fabFileId: 'doc-a', fileName: 'a.md', role: 'kept' },
      { fabFileId: 'doc-b', fileName: 'b.md', role: 'retired' },
    ]);
    expect(stored.actorUserId).toBe('curator-1');
    expect(stored.principal).toEqual({ principalKind: 'user', principalId: 'curator-1' });
    expect(stored.rung).toBe('creator');
  });

  it('lists a lake newest first', async () => {
    await repo.record(event({ at: new Date('2026-09-01T00:00:00Z') }));
    await repo.record(event({ at: new Date('2026-09-03T00:00:00Z') }));
    await repo.record(event({ at: new Date('2026-09-02T00:00:00Z') }));

    const rows = await repo.listByLake('lake-1');

    expect(rows.map(r => r.at.toString())).toEqual([
      new Date('2026-09-03T00:00:00Z').toString(),
      new Date('2026-09-02T00:00:00Z').toString(),
      new Date('2026-09-01T00:00:00Z').toString(),
    ]);
  });

  it('narrows by findingId', async () => {
    await repo.record(event({ findingId: 'finding-1' }));
    await repo.record(event({ findingId: 'finding-2' }));

    const rows = await repo.listByLake('lake-1', { findingId: 'finding-2' });

    expect(rows).toHaveLength(1);
    expect(rows[0].findingId).toBe('finding-2');
  });

  it('narrows by action', async () => {
    await repo.record(event({ action: 'merge' }));
    await repo.record(
      event({ action: 'retag', targets: [{ fabFileId: 'doc-a', fileName: 'a.md', role: 'retagged' }] })
    );

    const rows = await repo.listByLake('lake-1', { action: 'retag' });

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('retag');
  });

  it('honors limit', async () => {
    await repo.record(event({ at: new Date('2026-09-01T00:00:00Z') }));
    await repo.record(event({ at: new Date('2026-09-02T00:00:00Z') }));
    await repo.record(event({ at: new Date('2026-09-03T00:00:00Z') }));

    const rows = await repo.listByLake('lake-1', { limit: 2 });

    expect(rows).toHaveLength(2);
  });

  it('scopes listing to one lake', async () => {
    await repo.record(event({ lakeId: 'lake-1' }));
    await repo.record(event({ lakeId: 'lake-2' }));

    expect(await repo.listByLake('lake-1')).toHaveLength(1);
    expect(await repo.listByLake('lake-2')).toHaveLength(1);
  });

  it('drops one lake without touching another', async () => {
    await repo.record(event({ lakeId: 'lake-1' }));
    await repo.record(event({ lakeId: 'lake-2' }));

    expect(await repo.deleteForLake('lake-1')).toBe(1);
    expect(await repo.listByLake('lake-1')).toHaveLength(0);
    expect(await repo.listByLake('lake-2')).toHaveLength(1);
  });

  it('builds both indexes with an _id tiebreak', async () => {
    const indexes = await DataLakeCorpusActionModel.collection.indexes();

    expect(indexes.find(i => i.name === 'lakeId_1_at_-1__id_-1')?.key).toEqual({ lakeId: 1, at: -1, _id: -1 });
    expect(indexes.find(i => i.name === 'lakeId_1_findingId_1_at_-1__id_-1')?.key).toEqual({
      lakeId: 1,
      findingId: 1,
      at: -1,
      _id: -1,
    });
  });
});
