import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

/**
 * Real Mongo: this method is an aggregation-pipeline update, so what it actually does to a stored
 * array is the only thing worth asserting. Renaming with `$[elem]` collapses two distinct names
 * onto one, and this is what removes the resulting duplicate - the issue's "a file carrying the
 * old name twice ends up fully updated".
 */
setupMongoTest();

describe('FabFileRepository.dedupeTagByUserId', () => {
  const userId = 'dedupe-tag-user';
  const otherUserId = 'someone-else';

  const seedRaw = async (tags: Record<string, unknown>[]): Promise<string> => {
    const doc = await FabFile.create({
      userId,
      fileName: 'seed.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags,
    });
    return doc.id as string;
  };
  const seed = (names: string[]) => seedRaw(names.map(name => ({ name, strength: 1 })));

  const rawOf = async (id: string) => FabFile.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  const rawTagsOf = async (id: string) => ((await rawOf(id))?.tags ?? []) as Record<string, unknown>[];
  const namesOf = async (id: string) => (await rawTagsOf(id)).map(t => t.name);

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('collapses a repeated name to a single entry', async () => {
    const file = await seed(['receipts', 'misc', 'receipts']);

    const modified = await fabFileRepository.dedupeTagByUserId(userId, 'receipts');

    expect(modified).toBe(1);
    expect(await namesOf(file)).toEqual(['receipts', 'misc']);
  });

  it('keeps the FIRST occurrence, with its strength and any undeclared fields', async () => {
    const file = await seedRaw([
      { name: 'receipts', strength: 9, source: 'import' },
      { name: 'misc', strength: 2 },
      { name: 'receipts', strength: 1 },
    ]);

    await fabFileRepository.dedupeTagByUserId(userId, 'receipts');

    expect(await rawTagsOf(file)).toEqual([
      { name: 'receipts', strength: 9, source: 'import' },
      { name: 'misc', strength: 2 },
    ]);
  });

  it('collapses casing variants and normalizes the survivor to the passed casing', async () => {
    const file = await seed(['Receipts', 'misc', 'RECEIPTS']);

    await fabFileRepository.dedupeTagByUserId(userId, 'Receipts');

    expect(await namesOf(file)).toEqual(['Receipts', 'misc']);
  });

  it('leaves the relative order of the other tags intact', async () => {
    const file = await seed(['a', 'receipts', 'b', 'receipts', 'c']);

    await fabFileRepository.dedupeTagByUserId(userId, 'receipts');

    expect(await namesOf(file)).toEqual(['a', 'receipts', 'b', 'c']);
  });

  it('does not rewrite a file that carries the name only once', async () => {
    const file = await seed(['receipts', 'misc']);
    const before = await rawTagsOf(file);

    const modified = await fabFileRepository.dedupeTagByUserId(userId, 'receipts');

    expect(modified).toBe(0);
    expect(await rawTagsOf(file)).toEqual(before);
  });

  // `tags` is [Object] with no sub-schema, so legacy rows really do carry elements with a missing
  // or non-string name. One of those must not decide the outcome for the whole user.
  it('survives a malformed tag element and still de-dupes the rest', async () => {
    const file = await seedRaw([
      { name: 'receipts', strength: 1 },
      { strength: 4 },
      { name: 42 },
      { name: 'receipts', strength: 1 },
    ]);

    const modified = await fabFileRepository.dedupeTagByUserId(userId, 'receipts');

    expect(modified).toBe(1);
    expect(await namesOf(file)).toEqual(['receipts', undefined, 42]);
  });

  it('treats regex metacharacters in the name literally', async () => {
    const file = await seed(['.*', 'misc', '.*']);
    const neighbour = await seed(['literal', 'literal']);

    await fabFileRepository.dedupeTagByUserId(userId, '.*');

    expect(await namesOf(file)).toEqual(['.*', 'misc']);
    // A match-everything regex would have collapsed this file too.
    expect(await namesOf(neighbour)).toEqual(['literal', 'literal']);
  });

  it("leaves another user's files alone", async () => {
    const theirs = await FabFile.create({
      userId: otherUserId,
      fileName: 'theirs.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: [
        { name: 'receipts', strength: 1 },
        { name: 'receipts', strength: 1 },
      ],
    });

    const modified = await fabFileRepository.dedupeTagByUserId(userId, 'receipts');

    expect(modified).toBe(0);
    expect(await namesOf(theirs.id as string)).toEqual(['receipts', 'receipts']);
  });

  it('reports zero for an empty name rather than matching everything', async () => {
    const file = await seed(['receipts', 'receipts']);

    expect(await fabFileRepository.dedupeTagByUserId(userId, '')).toBe(0);
    expect(await namesOf(file)).toEqual(['receipts', 'receipts']);
  });
});
