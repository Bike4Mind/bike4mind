import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { KnowledgeType } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile, fabFileRepository, fileTagRepository } from '@bike4mind/database';
import { tagService } from '@bike4mind/services';

/**
 * End-to-end guard that deleting a tag leaves the three surfaces AGREEING: the tag documents, the
 * tag-name strings on the files, and the aggregate the Workspaces tag counts read. Deleting the
 * document alone satisfied the first two by accident - chips stopped rendering because they
 * intersect documents with strings - while the aggregate kept counting the orphaned string.
 *
 * Drives the REAL tagService.remove through the REAL repositories. Consumes the built dist, so
 * `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;

const USER = 'lifecycle-user';
const OTHER_USER = 'someone-else';
const SCOPE = { userGroups: [], dataLakeTags: [] };

const db = { tags: fileTagRepository, fabFiles: fabFileRepository };

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
  await Promise.all([FabFile.deleteMany({}), TagModel().deleteMany({})]);
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

describe('tagService.remove keeps tag documents, file tags and the count aggregate in agreement', () => {
  it('strips the name everywhere, including a soft-deleted file an undelete would revive', async () => {
    const invoices = await fileTagRepository.findOrCreateByNameAndUserId('invoices', USER, {});
    await fileTagRepository.findOrCreateByNameAndUserId('receipts', USER, {});
    await fileTagRepository.findOrCreateByNameAndUserId('invoices-2024', USER, {});

    const both = await seedFile(['invoices', 'receipts']);
    const casingVariant = await seedFile(['Invoices']);
    const duplicated = await seedFile(['invoices', 'invoices']);
    const softDeleted = await seedFile(['invoices', 'receipts'], { deletedAt: new Date() });
    const substringNeighbour = await seedFile(['invoices-2024']);
    const otherUsersFile = await FabFile.create({
      userId: OTHER_USER,
      fileName: 'theirs.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: [{ name: 'invoices', strength: 1 }],
    });

    // Sanity: the aggregate really does see the orphan-prone rows before the delete, so a later
    // "no invoices bucket" assertion cannot pass just because the fixture never counted.
    expect(await countOf('invoices')).toBe(3);

    await tagService.remove(USER, { id: invoices.id }, { db });

    // 1. The tag document is gone, and the untouched ones survive.
    expect(await fileTagRepository.findByIdAndUserId(invoices.id, USER)).toBeNull();
    const remaining = (await fileTagRepository.findAllByUserId(USER)).map(t => t.name).sort();
    expect(remaining).toEqual(['invoices-2024', 'receipts']);

    // 2. No file of this user carries any casing of the name - soft-deleted included.
    expect(await rawTagsOf(both)).toEqual(['receipts']);
    expect(await rawTagsOf(casingVariant)).toEqual([]);
    expect(await rawTagsOf(duplicated)).toEqual([]);
    expect(await rawTagsOf(softDeleted)).toEqual(['receipts']);
    // The substring neighbour is a different tag and must survive.
    expect(await rawTagsOf(substringNeighbour)).toEqual(['invoices-2024']);
    // One user's tag edit must not rewrite another user's file.
    expect(await rawTagsOf(otherUsersFile.id as string)).toEqual(['invoices']);

    // 3. The aggregate agrees: no bucket for the deleted name in any casing.
    expect(await countOf('invoices')).toBe(0);
    expect(await countOf('Invoices')).toBe(0);
    expect(await countOf('receipts')).toBe(1);
    expect(await countOf('invoices-2024')).toBe(1);

    // 4. listFileTags never reports a count for a name no file carries.
    const rows = await tagService.listFileTags(USER, SCOPE, {
      db: { fileTags: fileTagRepository, fabFiles: fabFileRepository },
    });
    expect(rows.map(r => r.name).sort()).toEqual(['invoices-2024', 'receipts']);
    expect(rows.find(r => r.name === 'receipts')?.fileCount).toBe(1);

    // 5. The assertion the old code fails: undeleting must not bring the dead tag back.
    await FabFile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(softDeleted) },
      { $unset: { deletedAt: '' } }
    );
    expect(await countOf('invoices')).toBe(0);
    expect(await countOf('receipts')).toBe(2);
  }, 30000);
});
