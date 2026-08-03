import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

/**
 * Real Mongo, not a mock: the central fact here is that the update reaches EVERY matching element
 * of a stored array, which is exactly what the first-positional `tags.$.name` operator this method
 * shipped with got wrong. `tags` has no sub-schema, so this also pins that Mongoose can cast the
 * arrayFilters path at all.
 */
setupMongoTest();

describe('FabFileRepository.updateTagsByUserId', () => {
  const userId = 'rename-tag-user';
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

  // Straight from the collection: a soft-deleted document is invisible to the model's find hooks,
  // so asserting through findById would pass whether or not the rename landed.
  const rawOf = async (id: string) => FabFile.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  const rawTagsOf = async (id: string): Promise<string[]> =>
    (((await rawOf(id))?.tags ?? []) as { name: string }[]).map(t => t.name);

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  // The assertion the first-positional `tags.$.name` cannot satisfy: it renames `foo` and stops.
  it('renames EVERY occurrence within one document, not just the first', async () => {
    const file = await seed(['foo', 'bar', 'Foo']);

    await fabFileRepository.updateTagsByUserId(userId, 'foo', 'renamed');

    expect(await rawTagsOf(file)).toEqual(['renamed', 'bar', 'renamed']);
  });

  it('preserves the position and the other fields of each renamed element', async () => {
    const doc = await FabFile.create({
      userId,
      fileName: 'seed.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: [
        { name: 'keep', strength: 3 },
        { name: 'foo', strength: 7 },
      ],
    });

    await fabFileRepository.updateTagsByUserId(userId, 'foo', 'renamed');

    const tags = ((await rawOf(doc.id as string))?.tags ?? []) as { name: string; strength: number }[];
    expect(tags).toEqual([
      { name: 'keep', strength: 3 },
      { name: 'renamed', strength: 7 },
    ]);
  });

  it('renames across files and reports how many it touched', async () => {
    const a = await seed(['invoices']);
    const b = await seed(['invoices', 'misc']);
    const untouched = await seed(['misc']);

    const modified = await fabFileRepository.updateTagsByUserId(userId, 'invoices', 'receipts');

    expect(modified).toBe(2);
    expect(await rawTagsOf(a)).toEqual(['receipts']);
    expect(await rawTagsOf(b)).toEqual(['receipts', 'misc']);
    expect(await rawTagsOf(untouched)).toEqual(['misc']);
  });

  it('renames on a soft-deleted file, so an undelete cannot revive the old name', async () => {
    const deleted = await seed(['invoices'], { deletedAt: new Date() });

    await fabFileRepository.updateTagsByUserId(userId, 'invoices', 'receipts');

    expect(await rawTagsOf(deleted)).toEqual(['receipts']);
  });

  it('matches the whole name, so a neighbour containing it is not renamed', async () => {
    const file = await seed(['q1', 'q1-draft']);

    await fabFileRepository.updateTagsByUserId(userId, 'q1', 'quarter-one');

    expect(await rawTagsOf(file)).toEqual(['quarter-one', 'q1-draft']);
  });

  it('treats regex metacharacters in the old name literally', async () => {
    const file = await seed(['.*', 'invoices']);

    const modified = await fabFileRepository.updateTagsByUserId(userId, '.*', 'literal');

    expect(modified).toBe(1);
    expect(await rawTagsOf(file)).toEqual(['literal', 'invoices']);
  });

  it("leaves another user's files alone", async () => {
    const theirs = await FabFile.create({
      userId: otherUserId,
      fileName: 'theirs.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: [{ name: 'invoices', strength: 1 }],
    });

    const modified = await fabFileRepository.updateTagsByUserId(userId, 'invoices', 'receipts');

    expect(modified).toBe(0);
    expect(await rawTagsOf(theirs.id as string)).toEqual(['invoices']);
  });

  it('renames primaryTag only where it named the renamed tag', async () => {
    const pointed = await seed(['invoices'], { primaryTag: 'invoices' });
    const other = await seed(['invoices', 'misc'], { primaryTag: 'misc' });

    await fabFileRepository.updateTagsByUserId(userId, 'invoices', 'receipts');

    expect((await rawOf(pointed))?.primaryTag).toBe('receipts');
    expect((await rawOf(other))?.primaryTag).toBe('misc');
  });

  it('reports zero for an empty name rather than building a match-everything regex', async () => {
    const file = await seed(['invoices']);

    expect(await fabFileRepository.updateTagsByUserId(userId, '', 'receipts')).toBe(0);
    expect(await fabFileRepository.updateTagsByUserId(userId, 'invoices', '')).toBe(0);
    expect(await rawTagsOf(file)).toEqual(['invoices']);
  });
});
