import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

// Real-Mongo round-trips for the tag $pull primitive. A mock cannot prove that $pull with
// an $in over an array of {name, strength} subdocuments addresses each element's `name`,
// removes whole elements, and leaves everything else byte-identical.
describe('FabFileRepository.pullTagsByFabFileId', () => {
  setupMongoTest();

  const userId = 'pull-tags-user';

  const SEED_TAGS = [
    { name: 'mylake:invoices', strength: 0.4 },
    { name: 'mylake:2024/q1', strength: 0.5 },
    { name: 'datalake:org:mylake', strength: 1 },
    { name: 'mylake', strength: 0.6 },
    { name: 'zz-mylake:x', strength: 0.7 },
    { name: 'user-tag', strength: 0.8 },
    { name: 'datalake:org:other', strength: 1 },
  ];

  const seed = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const doc = await FabFile.create({
      userId,
      fileName: 'seed.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: SEED_TAGS,
      ...overrides,
    });
    return doc.id as string;
  };

  const tagsOf = async (id: string) => {
    const doc = await FabFile.findById(id);
    return (doc?.tags ?? []) as { name: string; strength: number }[];
  };

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('removes exactly the named tags and preserves the strength of the survivors', async () => {
    const id = await seed();

    await fabFileRepository.pullTagsByFabFileId(id, ['datalake:org:mylake', 'mylake:invoices']);

    expect(await tagsOf(id)).toEqual([
      { name: 'mylake:2024/q1', strength: 0.5 },
      { name: 'mylake', strength: 0.6 },
      { name: 'zz-mylake:x', strength: 0.7 },
      { name: 'user-tag', strength: 0.8 },
      { name: 'datalake:org:other', strength: 1 },
    ]);
  });

  it('removes several tags in a single call', async () => {
    const id = await seed();

    await fabFileRepository.pullTagsByFabFileId(id, ['datalake:org:mylake', 'mylake:invoices', 'mylake:2024/q1']);

    const names = (await tagsOf(id)).map(t => t.name);
    expect(names).not.toContain('mylake:invoices');
    expect(names).not.toContain('mylake:2024/q1');
    expect(names).toContain('mylake');
  });

  // Exact-name matching is the whole point: the caller resolves which tags belong to the
  // lake, so a name that merely CONTAINS or is contained by a target must survive.
  it('matches whole names only, never a substring or a prefix relationship', async () => {
    const id = await seed();

    await fabFileRepository.pullTagsByFabFileId(id, ['mylake']);

    const names = (await tagsOf(id)).map(t => t.name);
    expect(names).not.toContain('mylake');
    expect(names).toContain('mylake:invoices');
    expect(names).toContain('zz-mylake:x');
  });

  it('is case-sensitive, matching how the read path compares tag names', async () => {
    const id = await seed({ tags: [{ name: 'MyLake:x', strength: 1 }] });

    await fabFileRepository.pullTagsByFabFileId(id, ['mylake:x']);

    expect((await tagsOf(id)).map(t => t.name)).toEqual(['MyLake:x']);
  });

  it('leaves the file untouched for an empty name list', async () => {
    const id = await seed();
    const before = await FabFile.findById(id);

    const modified = await fabFileRepository.pullTagsByFabFileId(id, []);

    expect(modified).toBe(0);
    expect(await tagsOf(id)).toHaveLength(SEED_TAGS.length);
    // Timestamps would move even on a no-op $pull, which is why the empty case short-circuits.
    expect((await FabFile.findById(id))?.updatedAt).toEqual(before?.updatedAt);
  });

  // Pins the documented contract the lake membership audit trail depends on: an unmatched pull
  // reports NO modification, so a caller can read the count as "a tag was removed" rather than
  // as "timestamps moved".
  it('reports no modification when no named tag was present', async () => {
    const id = await seed();
    const before = await FabFile.findById(id);

    expect(await fabFileRepository.pullTagsByFabFileId(id, ['not-on-this-file'])).toBe(0);
    expect(await tagsOf(id)).toHaveLength(SEED_TAGS.length);
    expect((await FabFile.findById(id))?.updatedAt).toEqual(before?.updatedAt);
  });

  // The concurrency shape the count exists for: two removals of the same tag race, the first
  // wins, and the loser must be able to tell it removed nothing.
  it('reports a modification for the first removal only when the same pull is repeated', async () => {
    const id = await seed();

    expect(await fabFileRepository.pullTagsByFabFileId(id, ['datalake:org:mylake'])).toBe(1);
    expect(await fabFileRepository.pullTagsByFabFileId(id, ['datalake:org:mylake'])).toBe(0);
  });

  it('is idempotent - a second identical call removes nothing more', async () => {
    const id = await seed();

    await fabFileRepository.pullTagsByFabFileId(id, ['datalake:org:mylake']);
    const afterFirst = await tagsOf(id);
    await fabFileRepository.pullTagsByFabFileId(id, ['datalake:org:mylake']);

    expect(await tagsOf(id)).toEqual(afterFirst);
  });

  it('clears primaryTag when it names a removed tag', async () => {
    const id = await seed({ primaryTag: 'mylake:invoices' });

    await fabFileRepository.pullTagsByFabFileId(id, ['datalake:org:mylake', 'mylake:invoices']);

    expect((await FabFile.findById(id))?.primaryTag).toBeUndefined();
  });

  it('keeps primaryTag when it names a tag that survives', async () => {
    const id = await seed({ primaryTag: 'user-tag' });

    await fabFileRepository.pullTagsByFabFileId(id, ['datalake:org:mylake', 'mylake:invoices']);

    expect((await FabFile.findById(id))?.primaryTag).toBe('user-tag');
  });

  it('still reports the tag removal when the primaryTag cleanup write rejects', async () => {
    const id = await seed({ primaryTag: 'mylake:invoices' });

    // The $pull (first call) must land for real; only the second, primaryTag $unset call fails.
    const realUpdateOne = FabFile.updateOne.bind(FabFile);
    let call = 0;
    vi.spyOn(FabFile, 'updateOne').mockImplementation((...args: Parameters<typeof FabFile.updateOne>) => {
      call += 1;
      if (call === 2) return Promise.reject(new Error('primaryTag write boom')) as any;
      return realUpdateOne(...args);
    });

    await expect(fabFileRepository.pullTagsByFabFileId(id, ['datalake:org:mylake', 'mylake:invoices'])).resolves.toBe(
      1
    );

    vi.restoreAllMocks();
    expect((await tagsOf(id)).map(t => t.name)).not.toContain('mylake:invoices');
    // The committed $pull is not undone by the rejected second write; the stale primaryTag is
    // left in place rather than the whole removal being thrown away.
    expect((await FabFile.findById(id))?.primaryTag).toBe('mylake:invoices');
  });

  it('does not throw for an id that matches no document', async () => {
    await expect(
      fabFileRepository.pullTagsByFabFileId('507f1f77bcf86cd799439011', ['datalake:org:mylake'])
    ).resolves.toBe(0);
  });
});
