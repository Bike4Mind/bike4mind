import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { KnowledgeType } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import { DataLakeModel, dataLakeRepository, FabFile, fabFileRepository, fileTagRepository } from '@bike4mind/database';
import { tagService } from '@bike4mind/services';

/**
 * End-to-end guard that renaming a tag - INTO a name the user already has, with duplicates, a
 * casing variant, a substring neighbour and a soft-deleted file all in play - leaves the tag
 * documents, the tag names stored on the files, and the count aggregate all telling the same
 * story. Renaming the document alone left the old name on every file, and the first-positional
 * update this replaces would leave a duplicated name half-renamed.
 *
 * Drives the REAL tagService.update through the REAL repositories. Consumes the built dist, so
 * `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;

const USER = 'rename-lifecycle-user';
const OTHER_USER = 'someone-else';
const SCOPE = { userGroups: [], dataLakeTags: [] };

const db = { tags: fileTagRepository, fabFiles: fabFileRepository, dataLakes: dataLakeRepository };

// The Tag model is registered by importing @bike4mind/database but is not exported from it.
const TagModel = () => mongoose.model('Tag');

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);
afterEach(async () => {
  await Promise.all([FabFile.deleteMany({}), TagModel().deleteMany({}), DataLakeModel.deleteMany({})]);
});

const seedFile = async (tags: string[], overrides: Record<string, unknown> = {}) => {
  const doc = await FabFile.create({
    userId: USER,
    fileName: 'seed.txt',
    type: KnowledgeType.FILE,
    mimeType: 'text/plain',
    tags: tags.map(name => ({ name, strength: 1 })),
    ...overrides,
  });
  return doc.id as string;
};

const rawTagsOf = async (id: string): Promise<string[]> => {
  const raw = await FabFile.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  return ((raw?.tags ?? []) as { name: string }[]).map(t => t.name);
};

const countOf = async (tag: string): Promise<number> => {
  const counts = await fabFileRepository.countFilesByTagForUser(USER, SCOPE);
  return counts.find(c => c.tag === tag)?.count ?? 0;
};

describe('tagService.update keeps tag documents, file tags and the count aggregate in agreement', () => {
  it('merges a rename onto an existing tag without leaving duplicates or orphans', async () => {
    const invoices = await fileTagRepository.findOrCreateByNameAndUserId('invoices', USER, {});
    const receipts = await fileTagRepository.findOrCreateByNameAndUserId('Receipts', USER, {});
    await fileTagRepository.findOrCreateByNameAndUserId('invoices-2024', USER, {});

    const plain = await seedFile(['invoices', 'misc']);
    const casingVariant = await seedFile(['Invoices']);
    const duplicated = await seedFile(['invoices', 'invoices']);
    const alreadyHasTarget = await seedFile(['invoices', 'Receipts']);
    const substringNeighbour = await seedFile(['invoices-2024']);
    const softDeleted = await seedFile(['invoices'], { deletedAt: new Date() });
    const otherUsersFile = await FabFile.create({
      userId: OTHER_USER,
      fileName: 'theirs.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: [{ name: 'invoices', strength: 1 }],
    });

    // Sanity: the fixture really does carry the pre-rename shape, so the assertions below cannot
    // pass just because nothing was ever there.
    expect(await countOf('invoices')).toBe(4);

    await tagService.update(USER, { id: invoices.id, name: 'Receipts' }, { db });

    // 1. Exactly one document folds to the target, it is the one that was renamed, and the
    //    collider is gone.
    const docs = await fileTagRepository.findAllByUserId(USER);
    const folded = docs.filter(t => t.name.toLowerCase() === 'receipts');
    expect(folded).toHaveLength(1);
    expect(folded[0].id).toBe(invoices.id);
    expect(folded[0].name).toBe('Receipts');
    expect(await fileTagRepository.findByIdAndUserId(receipts.id, USER)).toBeNull();
    expect(docs.map(t => t.name).sort()).toEqual(['Receipts', 'invoices-2024']);

    // 2. Every file carries the new name exactly once - including the one that already had it.
    expect(await rawTagsOf(plain)).toEqual(['Receipts', 'misc']);
    expect(await rawTagsOf(casingVariant)).toEqual(['Receipts']);
    expect(await rawTagsOf(duplicated)).toEqual(['Receipts']);
    expect(await rawTagsOf(alreadyHasTarget)).toEqual(['Receipts']);
    // A different tag that merely contains the old name must survive untouched.
    expect(await rawTagsOf(substringNeighbour)).toEqual(['invoices-2024']);
    expect(await rawTagsOf(softDeleted)).toEqual(['Receipts']);
    // One user's rename must not rewrite another user's file.
    expect(await rawTagsOf(otherUsersFile.id as string)).toEqual(['invoices']);

    // 3. The aggregate agrees. Four live files carry it (the soft-deleted one is excluded); the
    //    number is pinned so a future $unwind change cannot quietly double-count the two files
    //    that briefly held the name twice.
    expect(await countOf('invoices')).toBe(0);
    expect(await countOf('Invoices')).toBe(0);
    expect(await countOf('Receipts')).toBe(4);
    expect(await countOf('invoices-2024')).toBe(1);

    // 4. listFileTags reports the same number, and no row names a tag no file carries.
    const rows = await tagService.listFileTags(USER, SCOPE, {
      db: { fileTags: fileTagRepository, fabFiles: fabFileRepository },
    });
    expect(rows.map(r => r.name).sort()).toEqual(['Receipts', 'invoices-2024']);
    expect(rows.find(r => r.name === 'Receipts')?.fileCount).toBe(4);

    // 5. Re-running the identical request changes nothing, which is what makes the retry path in
    //    the service safe.
    await tagService.update(USER, { id: invoices.id, name: 'Receipts' }, { db });
    expect(await rawTagsOf(duplicated)).toEqual(['Receipts']);
    expect(await rawTagsOf(alreadyHasTarget)).toEqual(['Receipts']);
    expect(await countOf('Receipts')).toBe(4);
  }, 30000);
});

// Against REAL Mongo, not a mock: proves the recompute reads the aggregate AFTER the rename has
// actually persisted, both for a lake the rename joins and one it leaves.
describe('tagService.update recomputes a lake whose prefix-arm signal the rename crosses', () => {
  it('picks up fileCount when the new name newly satisfies a lake prefix', async () => {
    const lake = await DataLakeModel.create({
      name: 'Lake',
      slug: 'lake',
      fileTagPrefix: 'lk:',
      datalakeTag: 'datalake:lake',
      createdByUserId: USER,
      fileCount: 0,
      totalSizeBytes: 0,
    });
    const archived = await fileTagRepository.findOrCreateByNameAndUserId('archived', USER, {});
    await seedFile(['archived']);

    await tagService.update(USER, { id: archived.id, name: 'lk:invoices' }, { db });

    const persisted = await DataLakeModel.findById(lake.id);
    expect(persisted?.fileCount).toBe(1);
  }, 30000);

  it('drops fileCount when the rename moves the file to no longer carry a prefix tag', async () => {
    const lake = await DataLakeModel.create({
      name: 'Lake',
      slug: 'lake',
      fileTagPrefix: 'lk:',
      datalakeTag: 'datalake:lake',
      createdByUserId: USER,
      fileCount: 1,
      totalSizeBytes: 10,
    });
    const invoices = await fileTagRepository.findOrCreateByNameAndUserId('lk:invoices', USER, {});
    await seedFile(['lk:invoices']);

    await tagService.update(USER, { id: invoices.id, name: 'archived' }, { db });

    const persisted = await DataLakeModel.findById(lake.id);
    expect(persisted?.fileCount).toBe(0);
  }, 30000);
});
