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
// One server for both describes below - setupMongoTest registers beforeAll/afterAll, so calling
// it per describe would start and stop a second mongodb-memory-server for no reason.
setupMongoTest();

describe('FabFileRepository.countFilesByTagForUser', () => {
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

  // The badge is compared against a list built by buildFabFileSearchQuery, which filters
  // archivedAt: null. Archiving a data lake stamps archivedAt on every file it holds, so without
  // the matching conjunct the tag keeps counting while the list it labels shows nothing.
  describe('archived files', () => {
    const archive = (id: string) => FabFile.updateOne({ _id: id }, { $set: { archivedAt: new Date() } });

    it('stops counting a file once it is archived', async () => {
      const id = await seed(['invoices']);
      await seed(['invoices']);
      expect(await countOf('invoices', OPTIONS)).toBe(2);

      await archive(id);

      expect(await countOf('invoices', OPTIONS)).toBe(1);
    });

    it('drops the tag entirely when every file carrying it is archived', async () => {
      const id = await seed(['invoices']);

      await archive(id);

      const counts = await fabFileRepository.countFilesByTagForUser(userId, OPTIONS);
      expect(counts.some(c => c.tag === 'invoices')).toBe(false);
    });

    it('counts the file again once it is unarchived', async () => {
      const id = await seed(['invoices']);
      await archive(id);
      expect(await countOf('invoices', OPTIONS)).toBe(0);

      await FabFile.updateOne({ _id: id }, { $set: { archivedAt: null } });

      expect(await countOf('invoices', OPTIONS)).toBe(1);
    });

    // The conjunct is written as equality to null, which also matches documents that have no
    // archivedAt field at all - every file that predates the data-lake archive feature.
    it('still counts a file that has no archivedAt field', async () => {
      const id = await seed(['invoices']);
      await FabFile.updateOne({ _id: id }, { $unset: { archivedAt: 1 } });

      expect(await countOf('invoices', OPTIONS)).toBe(1);
    });
  });
});

/**
 * Served in the same response as the tag counts above, and the client sizes its workspace rows
 * from these numbers while keying the rows off the tag counts - so the two have to cover one file
 * set. Both halves of that are pinned here: the shared scope, and the archived exclusion.
 */
describe('FabFileRepository.countUniqueFilesByNamespaceForUser', () => {
  const userId = 'namespace-counts-user';
  const otherUserId = 'someone-else';
  const LAKE_TAG = 'datalake:acme:handbook';

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

  const countOf = async (
    namespace: string,
    options?: Parameters<typeof fabFileRepository.countUniqueFilesByNamespaceForUser>[1]
  ) => {
    const counts = await fabFileRepository.countUniqueFilesByNamespaceForUser(userId, options);
    return counts.find(c => c.namespace === namespace)?.fileCount ?? 0;
  };

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('counts a file once per namespace however many tags it carries there', async () => {
    await seed(['clients:acme', 'clients:globex', 'projects:apollo']);

    expect(await countOf('clients')).toBe(1);
    expect(await countOf('projects')).toBe(1);
  });

  it('stops counting an archived file', async () => {
    const id = await seed(['clients:acme']);
    await seed(['clients:globex']);
    expect(await countOf('clients')).toBe(2);

    await FabFile.updateOne({ _id: id }, { $set: { archivedAt: new Date() } });

    expect(await countOf('clients')).toBe(1);
  });

  it('omits a namespace whose every file is archived rather than reporting it as zero', async () => {
    const id = await seed(['clients:acme']);

    await FabFile.updateOne({ _id: id }, { $set: { archivedAt: new Date() } });

    const counts = await fabFileRepository.countUniqueFilesByNamespaceForUser(userId);
    expect(counts.some(c => c.namespace === 'clients')).toBe(false);
  });

  // A data-lake file is reachable through the dataLakeTags ownership arm, not through userId.
  // Without the scope the namespace renders as zero next to a non-zero tag count.
  it('counts a data-lake file the caller does not own only when the scope is supplied', async () => {
    await seed([LAKE_TAG, 'handbook:onboarding'], { userId: otherUserId });

    expect(await countOf('handbook')).toBe(0);
    expect(await countOf('handbook', { userGroups: [], dataLakeTags: [LAKE_TAG] })).toBe(1);
  });

  it('excludes session-attached files unless they are curated notebooks', async () => {
    await seed(['clients:acme'], { sessionId: 'session-1' });
    expect(await countOf('clients')).toBe(0);

    await seed(['clients:globex', 'curated-notebook'], { sessionId: 'session-2' });
    expect(await countOf('clients')).toBe(1);
  });

  it('stops counting a soft-deleted file', async () => {
    const id = await seed(['clients:acme']);
    await seed(['clients:globex']);

    await FabFile.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

    expect(await countOf('clients')).toBe(1);
  });

  it('ignores another user files when no scope is supplied', async () => {
    await seed(['clients:acme'], { userId: otherUserId });

    expect(await countOf('clients')).toBe(0);
  });
});
