import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

// Real-Mongo round-trips for the claim the bulk tag doors mint their membership events from. A mock
// cannot prove that the write picks the file itself (so two concurrent doors split the work rather
// than both claiming all of it), nor that its anchored/escaped/case-insensitive match lands on the
// SAME files the bulk writes next to it (removeTagByUserId, updateTagsByUserId) would touch.
describe('FabFileRepository.claimTagRewriteByUserId', () => {
  setupMongoTest();

  const userId = 'claim-tag-user';

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

  const storedTags = async (id: string) => (await FabFile.findById(id))?.toJSON().tags;

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('returns the PRE-IMAGE of the file it rewrote, not the result', async () => {
    const id = await seed();

    const prior = await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', 'archived');

    expect(prior?.id).toBe(id);
    // The membership diff is taken across this boundary, so the claim has to hand back the state
    // BEFORE its own write - the after-state is what the caller predicts from it.
    expect(prior?.tags).toEqual([{ name: 'lk:reports', strength: 0.5 }]);
    expect(await storedTags(id)).toEqual([{ name: 'archived', strength: 0.5 }]);
  });

  it('strips the tag when no new name is given, leaving the rest of the array alone', async () => {
    const id = await seed({
      tags: [
        { name: 'lk:reports', strength: 0.5 },
        { name: 'keep-me', strength: 1 },
      ],
    });

    const prior = await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', null);

    expect(prior?.id).toBe(id);
    expect(await storedTags(id)).toEqual([{ name: 'keep-me', strength: 1 }]);
  });

  it('claims one file per call and reports null once nothing unclaimed is left', async () => {
    await seed();
    await seed();

    const first = await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', null, []);
    const second = await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', null, [first!.id]);
    const third = await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', null, [first!.id, second!.id]);

    expect([first?.id, second?.id].sort()).toHaveLength(2);
    expect(first?.id).not.toBe(second?.id);
    expect(third).toBeNull();
  });

  // What makes the audit honest: the second caller cannot re-claim a file the first one already
  // rewrote, so only one of two concurrent doors records that file's transition.
  it('does not re-claim a file whose tag this same write already rewrote', async () => {
    await seed();

    const first = await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', 'archived');
    const second = await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', 'archived');

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  // A case-only rename still satisfies the case-insensitive filter afterwards, so the exclusion
  // list - not the filter - is what terminates a caller's loop.
  it('honours excludeIds on a case-only rename, which still matches its own filter', async () => {
    const id = await seed();

    const first = await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', 'LK:Reports');
    const again = await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', 'LK:Reports', [id]);

    expect(first?.id).toBe(id);
    expect(again).toBeNull();
  });

  // The writes this claim stands in for match case-insensitively, so a case-sensitive claim would
  // miss exactly the files they are about to move.
  it('matches the stored name case-insensitively', async () => {
    const id = await seed({ tags: [{ name: 'LK:Reports', strength: 0.5 }] });

    const prior = await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', null);

    expect(prior?.id).toBe(id);
    expect(await storedTags(id)).toEqual([]);
  });

  // Anchored, not a substring match: unanchored, `lk:report` would also claim `lk:reports`, minting
  // a membership event for a file no bulk write touched.
  it('matches the whole name only, never a prefix or a substring', async () => {
    await seed({ tags: [{ name: 'lk:reports-archive', strength: 0.5 }] });
    await seed({ tags: [{ name: 'old-lk:reports', strength: 0.5 }] });

    expect(await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', null)).toBeNull();
  });

  it('escapes regex metacharacters in the name rather than interpreting them', async () => {
    const id = await seed({ tags: [{ name: 'lk:a.b', strength: 0.5 }] });
    await seed({ tags: [{ name: 'lk:axb', strength: 0.5 }] });

    const prior = await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:a.b', null);

    expect(prior?.id).toBe(id);
  });

  // Unlike removeTagByUserId/updateTagsByUserId, which deliberately include soft-deleted files: one
  // is already out of every lake read, so an event for it would double-report against the one the
  // delete door already recorded. Those bulk writes still reach it.
  it('leaves soft-deleted files to the bulk write', async () => {
    await seed({ deletedAt: new Date() });

    expect(await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', null)).toBeNull();
  });

  it("excludes another user's files, matching the write's ownership scope", async () => {
    await seed({ userId: 'someone-else' });

    expect(await fabFileRepository.claimTagRewriteByUserId(userId, 'lk:reports', null)).toBeNull();
  });

  it('claims nothing for an empty name rather than matching every file', async () => {
    const id = await seed();

    expect(await fabFileRepository.claimTagRewriteByUserId(userId, '', null)).toBeNull();
    expect(await storedTags(id)).toEqual([{ name: 'lk:reports', strength: 0.5 }]);
  });
});
