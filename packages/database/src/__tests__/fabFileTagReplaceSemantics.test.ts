import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

// The data-lake removal gate on PUT /api/files/{id} rests on two framework behaviors that no
// mock can establish: that an absent `tags` key leaves the stored array alone (so an omitted key
// is NOT a membership change), and that an empty array really does clear it (so an empty array IS
// a wholesale removal that has to be authorized). If either ever changed, the gate would silently
// go back to letting an unauthorized eviction through.
describe('FabFile tag-replace semantics the lake removal gate depends on', () => {
  setupMongoTest();

  const userId = 'tag-replace-user';
  const LAKE_TAG = 'datalake:org:mylake';
  const SEED_TAGS = [
    { name: LAKE_TAG, strength: 1 },
    { name: 'user-tag', strength: 0.8 },
  ];

  const seed = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const doc = await FabFile.create({
      userId,
      fileName: 'seed.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      fileSize: 100,
      tags: SEED_TAGS,
      ...overrides,
    });
    return doc.id as string;
  };

  const tagsOf = async (id: string) => {
    const doc = await FabFile.findById(id);
    return (doc?.tags ?? []).map(tag => ({ name: tag.name, strength: tag.strength }));
  };

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('leaves the stored tags untouched when tags is undefined', async () => {
    const id = await seed();

    await fabFileRepository.update({ id, fileName: 'renamed.txt', tags: undefined });

    expect(await tagsOf(id)).toEqual(SEED_TAGS);
    expect((await FabFile.findById(id))?.fileName).toBe('renamed.txt');
  });

  it('clears every tag when tags is an empty array', async () => {
    const id = await seed();

    await fabFileRepository.update({ id, tags: [] });

    expect(await tagsOf(id)).toEqual([]);
  });

  // Justifies diffing the submitted tags against the stored ones on RAW names: the stats
  // aggregate matches the meta-tag exactly, so a case-only rewrite drops the file out of the
  // lake's counts for real. A case-folded diff would read that rewrite as a harmless no-op.
  it('does not count a case-mismatched meta-tag toward a lake', async () => {
    await seed();
    await seed({ fileName: 'other.txt', tags: [{ name: 'DataLake:Org:MyLake', strength: 1 }] });

    // Meta-tag-only scope: no prefix, so the two-signal filter falls back to the exact meta-tag
    // arm - which is the arm this case is about.
    const scope = { datalakeTag: LAKE_TAG, fileTagPrefix: undefined, creatorUserId: userId };
    expect(await fabFileRepository.computeDataLakeStats(scope)).toEqual({ fileCount: 1, totalSizeBytes: 100 });
  });
});
