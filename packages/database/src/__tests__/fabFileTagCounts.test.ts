import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

/**
 * Real-Mongo coverage for the aggregate that tagService/listFileTags serves as `fileCount`.
 * A mock cannot prove what the $unwind/$group actually returns, and two of the facts pinned here
 * are load-bearing for the caller: that a tag removed by $pull immediately stops counting (the
 * whole point of recomputing instead of maintaining a stored counter), and that names differing
 * only in case come back as SEPARATE buckets, which is why listFileTags sums them.
 */
describe('FabFileRepository.countFilesByTagForUser', () => {
  setupMongoTest();

  const userId = 'tag-counts-user';
  const otherUserId = 'someone-else';
  const OPTIONS = { userGroups: [], dataLakeTags: [] };

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

  const countOf = async (tag: string, options?: Parameters<typeof fabFileRepository.countFilesByTagForUser>[1]) => {
    const counts = await fabFileRepository.countFilesByTagForUser(userId, options);
    return counts.find(c => c.tag === tag)?.count ?? 0;
  };

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  // The acceptance criterion for the drift this replaces: the $pull removal path never touched
  // the stored counter, so a tag removed that way stayed one too high forever.
  it('drops a tag removed by pullTagsByFabFileId on the very next read', async () => {
    const first = await seed(['invoices']);
    await seed(['invoices']);
    await seed(['invoices']);
    expect(await countOf('invoices', OPTIONS)).toBe(3);

    await fabFileRepository.pullTagsByFabFileId(first, ['invoices']);

    expect(await countOf('invoices', OPTIONS)).toBe(2);
  });

  it('stops counting a soft-deleted file', async () => {
    const id = await seed(['invoices']);
    await seed(['invoices']);

    await FabFile.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

    expect(await countOf('invoices', OPTIONS)).toBe(1);
  });

  it('returns names differing only in case as separate buckets', async () => {
    await seed(['Invoices']);
    await seed(['invoices']);

    const counts = await fabFileRepository.countFilesByTagForUser(userId, OPTIONS);
    const invoiceBuckets = counts.filter(c => c.tag.toLowerCase() === 'invoices');

    expect(invoiceBuckets).toHaveLength(2);
    expect(invoiceBuckets.reduce((sum, c) => sum + c.count, 0)).toBe(2);
  });

  it('counts a file once however many tags it carries', async () => {
    await seed(['invoices', 'receipts', 'invoices-archive']);

    expect(await countOf('invoices', OPTIONS)).toBe(1);
    expect(await countOf('receipts', OPTIONS)).toBe(1);
  });

  it('excludes session-attached files unless they are curated notebooks', async () => {
    await seed(['invoices'], { sessionId: 'session-1' });
    expect(await countOf('invoices', OPTIONS)).toBe(0);

    await seed(['invoices', 'curated-notebook'], { sessionId: 'session-2' });
    expect(await countOf('invoices', OPTIONS)).toBe(1);
  });

  it('still counts the caller own files when scoping options are supplied', async () => {
    await seed(['invoices']);

    expect(await countOf('invoices')).toBe(1);
    expect(await countOf('invoices', OPTIONS)).toBe(1);
  });

  it('ignores files belonging to another user', async () => {
    await seed(['invoices'], { userId: otherUserId });

    expect(await countOf('invoices', OPTIONS)).toBe(0);
  });

  it('omits a tag no live file carries rather than reporting it as zero', async () => {
    await seed(['invoices']);

    const counts = await fabFileRepository.countFilesByTagForUser(userId, OPTIONS);

    expect(counts.some(c => c.tag === 'never-used')).toBe(false);
  });
});
