import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKES, type IDataLakeDocument } from '@bike4mind/common';
import { reconcileLakeTags } from './reconcileLakeTags';

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake',
    createdByUserId: 'owner',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

const owner = { userId: 'owner', isAdmin: false };
const tag = (name: string, strength = 0) => ({ name, strength });

const makeAdapters = (
  storedTags: { name: string; strength: number }[],
  lakeDoc: IDataLakeDocument | null = lake()
) => ({
  db: {
    fabFiles: {
      findById: vi.fn().mockResolvedValue({ id: 'f1', userId: 'owner', tags: storedTags }),
      pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
      pushTagsByFabFileId: vi.fn().mockResolvedValue(1),
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 4, totalSizeBytes: 40 }),
    },
    dataLakes: {
      findByDatalakeTag: vi.fn().mockResolvedValue(lakeDoc),
      setStats: vi.fn(),
      // No prefix collisions in these tests; the fallback tagger's own logic is covered by
      // fallbackLakeTags.test.ts.
      find: vi.fn().mockResolvedValue([]),
    },
  },
});

const run = (
  adapters: ReturnType<typeof makeAdapters>,
  current: string[],
  desired: { name: string; strength: number }[]
) => reconcileLakeTags(owner, 'f1', current, desired, adapters as any);

describe('reconcileLakeTags', () => {
  it('passes ordinary tags through untouched and writes nothing', async () => {
    const adapters = makeAdapters([]);

    const result = await run(adapters, ['keep'], [tag('keep'), tag('added')]);
    await result.commit();

    expect(result.tagsToPersist).toEqual([tag('keep'), tag('added')]);
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
  });

  it('joins a lake whose meta-tag the caller added, and recomputes its stats', async () => {
    const adapters = makeAdapters([]);

    const result = await run(adapters, [], [tag('datalake:lake', 1)]);
    await result.commit();

    // The join is carried by the persisted array itself, so commit() issues no second write for
    // membership - only the stats recompute it cannot do. The array also gains a fallback
    // content tag: addFileToLake stamps only the meta-tag, and a join with no qualifying tag
    // under the lake's prefix would reproduce the "counted but not browseable" bug otherwise.
    expect(result.tagsToPersist).toEqual([tag('datalake:lake', 1), tag('lk:uncategorized', 1)]);
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', { fileCount: 4, totalSizeBytes: 40 });
  });

  // The whole point of routing this door through the membership path.
  it('clears the lake prefixed content tags on leave even when the caller re-listed them', async () => {
    const stored = [tag('datalake:lake', 1), tag('lk:invoices', 1), tag('unrelated')];
    const adapters = makeAdapters(stored);

    // The caller drops only the meta-tag and keeps the folder tag in the payload.
    const result = await run(
      adapters,
      ['datalake:lake', 'lk:invoices', 'unrelated'],
      [tag('lk:invoices', 1), tag('unrelated')]
    );

    // The meta-tag is persisted anyway, so membership is intact when the pull evaluates it.
    expect(result.tagsToPersist).toEqual([tag('lk:invoices', 1), tag('unrelated'), tag('datalake:lake', 1)]);

    await result.commit();

    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake', 'lk:invoices']);
    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', { fileCount: 4, totalSizeBytes: 40 });
  });

  it('leaves membership alone when the caller round-trips the meta-tag', async () => {
    // Also has no tag under 'lk:', so the fallback tagger backfills one - the invariant applies
    // on every write through this door, not only a join.
    const adapters = makeAdapters([tag('datalake:lake', 1)]);

    const result = await run(adapters, ['datalake:lake'], [tag('datalake:lake', 1), tag('note')]);
    await result.commit();

    expect(result.tagsToPersist).toEqual([tag('note'), tag('datalake:lake', 1), tag('lk:uncategorized', 1)]);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('normalizes a meta-tag the caller spelled in another casing', async () => {
    const adapters = makeAdapters([]);

    const result = await run(adapters, [], [tag('DataLake:Lake', 1)]);

    expect(adapters.db.dataLakes.findByDatalakeTag).toHaveBeenCalledWith('datalake:lake');
    expect(result.tagsToPersist).toEqual([tag('datalake:lake', 1), tag('lk:uncategorized', 1)]);
  });

  it('refuses a meta-tag the caller applied that names no lake', async () => {
    const adapters = makeAdapters([], null);

    await expect(run(adapters, [], [tag('datalake:ghost', 1)])).rejects.toThrow(/only the creator/i);
  });

  // A lake can be deleted out from under a file. The orphaned string must not make the file
  // uneditable - dropping it is a plain tag removal.
  it('lets an orphaned meta-tag be dropped without a lake write', async () => {
    const adapters = makeAdapters([tag('datalake:gone', 1)], null);

    const result = await run(adapters, ['datalake:gone'], [tag('note')]);
    await result.commit();

    expect(result.tagsToPersist).toEqual([tag('note')]);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  // The gates must fire before the caller persists anything: the tag array write alone would
  // already have granted or revoked membership.
  it('refuses a join by a caller who cannot manage the lake, before returning a payload', async () => {
    const adapters = makeAdapters([], lake({ createdByUserId: 'someone-else' }));

    await expect(run(adapters, [], [tag('datalake:lake', 1)])).rejects.toThrow(/only the creator can add/i);
  });

  it('refuses a leave by a caller who cannot manage the lake', async () => {
    const adapters = makeAdapters([tag('datalake:lake', 1)], lake({ createdByUserId: 'someone-else' }));

    await expect(run(adapters, ['datalake:lake'], [])).rejects.toThrow(/only the creator can remove/i);
  });

  // Two lakes can share a fileTagPrefix - nothing makes it unique. Leaving both in one call is
  // safe because the first pull excludes the reserved datalake: namespace, so the second lake's
  // meta-tag survives it and that lake is still seen as a member.
  it('leaves two lakes sharing a fileTagPrefix in one call', async () => {
    const lakeA = lake({ id: 'lakeA', datalakeTag: 'datalake:a', fileTagPrefix: 'qa:' });
    const lakeB = lake({ id: 'lakeB', datalakeTag: 'datalake:b', fileTagPrefix: 'qa:' });
    const stored = [tag('datalake:a', 1), tag('datalake:b', 1), tag('qa:shared', 1)];
    const adapters = makeAdapters(stored);
    adapters.db.dataLakes.findByDatalakeTag = vi.fn(async (t: string) => (t === 'datalake:a' ? lakeA : lakeB));

    const result = await run(adapters, ['datalake:a', 'datalake:b', 'qa:shared'], [tag('qa:shared', 1)]);
    await expect(result.commit()).resolves.toBeUndefined();

    const pulled = adapters.db.fabFiles.pullTagsByFabFileId.mock.calls.map(c => c[1]);
    expect(pulled).toEqual([
      ['datalake:a', 'qa:shared'],
      ['datalake:b', 'qa:shared'],
    ]);
    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledTimes(2);
  });

  it('treats a concurrent removal as the outcome the caller asked for', async () => {
    const adapters = makeAdapters([tag('datalake:lake', 1)]);
    const result = await run(adapters, ['datalake:lake'], []);
    // The tag went between the array write and the membership write.
    adapters.db.fabFiles.findById = vi.fn().mockResolvedValue({ id: 'f1', userId: 'owner', tags: [] });

    await expect(result.commit()).resolves.toBeUndefined();
    // Stats still recompute, so the lake's counts reflect whoever won the race.
    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledTimes(1);
  });

  it('refuses a built-in fallback lake', async () => {
    const fallback = lake({ id: DATA_LAKES[0].id, datalakeTag: DATA_LAKES[0].datalakeTag, createdByUserId: 'owner' });
    const adapters = makeAdapters([], fallback);

    await expect(run(adapters, [], [tag(DATA_LAKES[0].datalakeTag, 1)])).rejects.toThrow(/read-only/i);
  });
});
