import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

/**
 * Real Mongo, not a mock: every fact here is about what the $pull actually does to a stored array,
 * which a mock can only assert by restating the implementation. Two of them are the bugs this
 * method shipped with - an unanchored regex that ate neighbouring tag names, and a `deletedAt`
 * filter that let an undelete resurrect a deleted tag.
 */
setupMongoTest();

describe('FabFileRepository.removeTagByUserId', () => {
  const userId = 'remove-tag-user';
  const otherUserId = 'someone-else';

  const seed = async (tags: string[], overrides: Record<string, unknown> = {}): Promise<string> => {
    const doc = await FabFile.create({
      userId,
      fileName: 'seed.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: tags.map(name => ({ name, strength: 1 })),
      ...overrides,
    });
    return doc.id as string;
  };

  // Reads straight from the collection: a soft-deleted document is invisible to the model's
  // find hooks, so asserting through FabFile.findById would pass whether or not the tag was
  // actually stripped.
  const rawTagsOf = async (id: string): Promise<string[]> => {
    const raw = await FabFile.collection.findOne({ _id: FabFile.base.Types.ObjectId.createFromHexString(id) });
    return ((raw?.tags ?? []) as { name: string }[]).map(t => t.name);
  };

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('removes the tag from every file that carries it', async () => {
    const a = await seed(['invoices', 'receipts']);
    const b = await seed(['invoices']);
    const untouched = await seed(['receipts']);

    const modified = await fabFileRepository.removeTagByUserId(userId, 'invoices');

    expect(modified).toBe(2);
    expect(await rawTagsOf(a)).toEqual(['receipts']);
    expect(await rawTagsOf(b)).toEqual([]);
    expect(await rawTagsOf(untouched)).toEqual(['receipts']);
  });

  it('strips a soft-deleted file too, so an undelete cannot resurrect the tag', async () => {
    const deleted = await seed(['invoices', 'receipts'], { deletedAt: new Date() });

    await fabFileRepository.removeTagByUserId(userId, 'invoices');

    expect(await rawTagsOf(deleted)).toEqual(['receipts']);
  });

  it('matches the whole name, so a tag is not removed by a neighbour that contains it', async () => {
    const neighbours = await seed(['test', 'testing', 'unit-test']);

    await fabFileRepository.removeTagByUserId(userId, 'test');

    expect(await rawTagsOf(neighbours)).toEqual(['testing', 'unit-test']);
  });

  it('treats regex metacharacters in the name literally', async () => {
    const file = await seed(['.*', 'invoices']);

    const modified = await fabFileRepository.removeTagByUserId(userId, '.*');

    expect(modified).toBe(1);
    expect(await rawTagsOf(file)).toEqual(['invoices']);
  });

  it('removes every occurrence when one file carries the name more than once', async () => {
    const dup = await seed(['invoices', 'misc', 'invoices']);

    await fabFileRepository.removeTagByUserId(userId, 'invoices');

    expect(await rawTagsOf(dup)).toEqual(['misc']);
  });

  it('removes casing variants, matching how the UI decides two tags are the same', async () => {
    const mixed = await seed(['Invoices', 'invoices', 'misc']);

    await fabFileRepository.removeTagByUserId(userId, 'INVOICES');

    expect(await rawTagsOf(mixed)).toEqual(['misc']);
  });

  it("leaves another user's files alone", async () => {
    const theirs = await FabFile.create({
      userId: otherUserId,
      fileName: 'theirs.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: [{ name: 'invoices', strength: 1 }],
    });

    const modified = await fabFileRepository.removeTagByUserId(userId, 'invoices');

    expect(modified).toBe(0);
    expect(await rawTagsOf(theirs.id as string)).toEqual(['invoices']);
  });

  it('clears primaryTag only on the files where it named the removed tag', async () => {
    const pointed = await seed(['invoices'], { primaryTag: 'invoices' });
    const other = await seed(['invoices', 'receipts'], { primaryTag: 'receipts' });

    await fabFileRepository.removeTagByUserId(userId, 'invoices');

    const pointedRaw = await FabFile.collection.findOne({
      _id: FabFile.base.Types.ObjectId.createFromHexString(pointed),
    });
    const otherRaw = await FabFile.collection.findOne({
      _id: FabFile.base.Types.ObjectId.createFromHexString(other),
    });
    expect(pointedRaw?.primaryTag).toBeUndefined();
    expect(otherRaw?.primaryTag).toBe('receipts');
  });

  it('reports zero and writes nothing when no file carries the tag', async () => {
    const file = await seed(['receipts']);

    const modified = await fabFileRepository.removeTagByUserId(userId, 'invoices');

    expect(modified).toBe(0);
    expect(await rawTagsOf(file)).toEqual(['receipts']);
  });

  it('reports zero for an empty name rather than building a match-everything regex', async () => {
    const file = await seed(['invoices']);

    const modified = await fabFileRepository.removeTagByUserId(userId, '');

    expect(modified).toBe(0);
    expect(await rawTagsOf(file)).toEqual(['invoices']);
  });
});
