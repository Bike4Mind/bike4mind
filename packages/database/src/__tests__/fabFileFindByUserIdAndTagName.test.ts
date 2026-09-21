import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

// Real-Mongo round-trips for the read the bulk tag doors diff lake membership over. A mock cannot
// prove that the anchored/escaped/case-insensitive regex matches the SAME files the writes next to
// it (removeTagByUserId, updateTagsByUserId) will touch, which is the whole contract.
describe('FabFileRepository.findByUserIdAndTagName', () => {
  setupMongoTest();

  const userId = 'find-by-tag-user';

  const seed = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const doc = await FabFile.create({
      userId,
      fileName: 'seed.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: [{ name: 'lk:reports', strength: 0.5 }],
      ...overrides,
    });
    return doc.id as string;
  };

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('returns a file carrying the name, with its tags intact', async () => {
    const id = await seed();

    const files = await fabFileRepository.findByUserIdAndTagName(userId, 'lk:reports');

    expect(files.map(f => f.id)).toEqual([id]);
    expect(files[0].tags).toEqual([{ name: 'lk:reports', strength: 0.5 }]);
  });

  // The writes this read feeds match case-insensitively, so a case-sensitive read here would miss
  // exactly the files they are about to move.
  it('matches the stored name case-insensitively', async () => {
    const id = await seed({ tags: [{ name: 'LK:Reports', strength: 0.5 }] });

    const files = await fabFileRepository.findByUserIdAndTagName(userId, 'lk:reports');

    expect(files.map(f => f.id)).toEqual([id]);
  });

  // Anchored, not a substring match: unanchored, `lk:report` would also claim `lk:reports`, minting
  // a membership event for a file no write touched.
  it('matches the whole name only, never a prefix or a substring', async () => {
    await seed({ tags: [{ name: 'lk:reports-archive', strength: 0.5 }] });
    await seed({ tags: [{ name: 'old-lk:reports', strength: 0.5 }] });

    expect(await fabFileRepository.findByUserIdAndTagName(userId, 'lk:reports')).toEqual([]);
  });

  it('escapes regex metacharacters in the name rather than interpreting them', async () => {
    const id = await seed({ tags: [{ name: 'lk:a.b', strength: 0.5 }] });
    await seed({ tags: [{ name: 'lk:axb', strength: 0.5 }] });

    const files = await fabFileRepository.findByUserIdAndTagName(userId, 'lk:a.b');

    expect(files.map(f => f.id)).toEqual([id]);
  });

  // Unlike removeTagByUserId/updateTagsByUserId, which deliberately include soft-deleted files: one
  // is already out of every lake read, so an event for it would double-report against the one the
  // delete door already recorded.
  it('excludes soft-deleted files', async () => {
    await seed({ deletedAt: new Date() });

    expect(await fabFileRepository.findByUserIdAndTagName(userId, 'lk:reports')).toEqual([]);
  });

  it("excludes another user's files, matching the write's ownership scope", async () => {
    await seed({ userId: 'someone-else' });

    expect(await fabFileRepository.findByUserIdAndTagName(userId, 'lk:reports')).toEqual([]);
  });

  it('returns nothing for an empty name rather than matching every file', async () => {
    await seed();

    expect(await fabFileRepository.findByUserIdAndTagName(userId, '')).toEqual([]);
  });
});
