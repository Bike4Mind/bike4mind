import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

// Real-Mongo round-trips for the tag $push primitive, the add half of the atomic pair. A mock
// cannot prove that a filtered per-name $push skips a name that is already present, compares
// that presence case-insensitively, and leaves every other element byte-identical.
describe('FabFileRepository.pushTagsByFabFileId', () => {
  setupMongoTest();

  const userId = 'push-tags-user';

  const SEED_TAGS = [
    { name: 'mylake:invoices', strength: 0.4 },
    { name: 'datalake:org:mylake', strength: 1 },
    { name: 'user-tag', strength: 0.8 },
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

  it('appends a new tag at the default strength and leaves the existing ones byte-identical', async () => {
    const id = await seed();

    expect(await fabFileRepository.pushTagsByFabFileId(id, ['fresh-tag'])).toBe(1);

    expect(await tagsOf(id)).toEqual([...SEED_TAGS, { name: 'fresh-tag', strength: 0 }]);
  });

  it('stores the caller-supplied strength, which is how the lake meta-tag lands at 1', async () => {
    const id = await seed({ tags: [] });

    await fabFileRepository.pushTagsByFabFileId(id, ['datalake:org:other'], 1);

    expect(await tagsOf(id)).toEqual([{ name: 'datalake:org:other', strength: 1 }]);
  });

  it('adds several new names in a single call', async () => {
    const id = await seed();

    expect(await fabFileRepository.pushTagsByFabFileId(id, ['alpha', 'beta'])).toBe(2);

    const names = (await tagsOf(id)).map(t => t.name);
    expect(names).toEqual([...SEED_TAGS.map(t => t.name), 'alpha', 'beta']);
  });

  it('is idempotent - re-adding a present name inserts nothing and reports 0', async () => {
    const id = await seed();

    expect(await fabFileRepository.pushTagsByFabFileId(id, ['user-tag'])).toBe(0);

    expect(await tagsOf(id)).toEqual(SEED_TAGS);
  });

  // Per-name filters, not one $each push: a batch mixing present and absent names must apply
  // the absent ones instead of failing or duplicating wholesale.
  it('applies only the absent names when a batch mixes present and new', async () => {
    const id = await seed();

    expect(await fabFileRepository.pushTagsByFabFileId(id, ['user-tag', 'brand-new'])).toBe(1);

    expect(await tagsOf(id)).toEqual([...SEED_TAGS, { name: 'brand-new', strength: 0 }]);
  });

  it('treats a differently-cased name as a distinct tag, matching the exact-match read path', async () => {
    const id = await seed({ tags: [{ name: 'Foo', strength: 0.2 }] });

    expect(await fabFileRepository.pushTagsByFabFileId(id, ['foo'])).toBe(1);

    expect(await tagsOf(id)).toEqual([
      { name: 'Foo', strength: 0.2 },
      { name: 'foo', strength: 0 },
    ]);
  });

  // The case that makes exact matching load-bearing rather than merely simpler. A lake's read
  // arm matches its meta-tag by exact $in, so a file carrying another casing of that tag is NOT
  // a member; blocking the canonical tag on a case-insensitive collision would make joining the
  // lake a silent no-op.
  it('can stamp a canonical lake meta-tag onto a file carrying another casing of it', async () => {
    const id = await seed({ tags: [{ name: 'DataLake:Org:MyLake', strength: 1 }] });

    expect(await fabFileRepository.pushTagsByFabFileId(id, ['datalake:org:mylake'], 1)).toBe(1);

    expect((await tagsOf(id)).map(t => t.name)).toEqual(['DataLake:Org:MyLake', 'datalake:org:mylake']);
  });

  // The write path must never lowercase: the toggle door used to, which silently recased a
  // user's mixed-case tag.
  it('stores a genuinely new name with the caller casing intact', async () => {
    const id = await seed({ tags: [] });

    await fabFileRepository.pushTagsByFabFileId(id, ['MixedCase']);

    expect((await tagsOf(id)).map(t => t.name)).toEqual(['MixedCase']);
  });

  it('inserts once when one call repeats the same name', async () => {
    const id = await seed({ tags: [] });

    expect(await fabFileRepository.pushTagsByFabFileId(id, ['dup', 'dup'])).toBe(1);

    expect((await tagsOf(id)).map(t => t.name)).toEqual(['dup']);
  });

  // The guard is a plain equality test, never a pattern: a stored `axb` must not be read as a
  // match for `a.b` and silently skip a real insert.
  it('matches names literally rather than as a pattern', async () => {
    const id = await seed({ tags: [{ name: 'axb', strength: 0.1 }] });

    expect(await fabFileRepository.pushTagsByFabFileId(id, ['a.b'])).toBe(1);

    expect((await tagsOf(id)).map(t => t.name)).toEqual(['axb', 'a.b']);
  });

  it('leaves the file untouched for an empty name list', async () => {
    const id = await seed();
    const before = await FabFile.findById(id);

    expect(await fabFileRepository.pushTagsByFabFileId(id, [])).toBe(0);

    expect(await tagsOf(id)).toEqual(SEED_TAGS);
    // An add with nothing to add must not register as a write at all.
    expect((await FabFile.findById(id))?.updatedAt).toEqual(before?.updatedAt);
  });

  it('does not disturb primaryTag', async () => {
    const id = await seed({ primaryTag: 'user-tag' });

    await fabFileRepository.pushTagsByFabFileId(id, ['fresh-tag']);

    expect((await FabFile.findById(id))?.primaryTag).toBe('user-tag');
  });

  it('does not throw for an id that matches no document', async () => {
    await expect(fabFileRepository.pushTagsByFabFileId('507f1f77bcf86cd799439011', ['alpha'])).resolves.toBe(0);
  });

  // The reason the pair is atomic at all: a read-filter-write of the whole array on either half
  // would let the loser's snapshot resurrect the tag the winner just removed.
  it('does not clobber a concurrent pull of a different tag', async () => {
    for (let i = 0; i < 20; i++) {
      const id = await seed();

      await Promise.all([
        fabFileRepository.pushTagsByFabFileId(id, ['added-tag']),
        fabFileRepository.pullTagsByFabFileId(id, ['datalake:org:mylake']),
      ]);

      const names = (await tagsOf(id)).map(t => t.name);
      expect(names).toContain('added-tag');
      expect(names).not.toContain('datalake:org:mylake');
      expect(names).toContain('mylake:invoices');
      expect(names).toContain('user-tag');
    }
  });

  it('lands both tags when two adds of different names race', async () => {
    for (let i = 0; i < 20; i++) {
      const id = await seed({ tags: [] });

      await Promise.all([
        fabFileRepository.pushTagsByFabFileId(id, ['racer-a']),
        fabFileRepository.pushTagsByFabFileId(id, ['racer-b']),
      ]);

      expect((await tagsOf(id)).map(t => t.name).sort()).toEqual(['racer-a', 'racer-b']);
    }
  });
});
