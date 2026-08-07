import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { KnowledgeType, Permission } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  DataLakeModel,
  FabFile,
  User,
  dataLakeRepository,
  fabFileRepository,
  fileTagRepository,
  userRepository,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';

/**
 * End-to-end guard, against REAL Mongo rather than a mock, for #1263: a file whose ONLY lake
 * membership signal is a `fileTagPrefix` content tag (no `datalake:*` meta-tag) must be gated
 * and stats-recomputed on removal exactly like a meta-tag leave, through BOTH single-file write
 * doors. A mock can assert `removeFileFromLake` was called; only a real aggregate proves the
 * NotFoundError-swallow path it hits (the tag is already gone by the time it runs its own lookup)
 * is actually inert rather than silently skipping the recompute. Lives in apps/client because it
 * is the only package with both @bike4mind/services and @bike4mind/database as dependencies.
 * Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;
let ownerId: string;
let editorId: string;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  const owner = await User.create({ username: 'lake-owner', name: 'Owner' });
  const editor = await User.create({ username: 'shared-editor', name: 'Editor' });
  ownerId = owner.id as string;
  editorId = editor.id as string;
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);
afterEach(async () => {
  await FabFile.deleteMany({});
  await DataLakeModel.deleteMany({});
});

const makeLake = (overrides: Record<string, unknown> = {}) =>
  DataLakeModel.create({
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake',
    createdByUserId: ownerId,
    fileCount: 1,
    totalSizeBytes: 10,
    ...overrides,
  });

// Shared with the editor (write access, not ownership) so a "shared editor, not the lake
// creator" scenario is reachable at all - an unshared user is refused earlier, at the file-access
// gate. `status: 'complete'` matters: computeDataLakeStats excludes the schema's own default
// ('pending'), so a file left at the default is invisible to the aggregate regardless of tags -
// that would make every assertion below pass whether or not the fix actually works.
const makeFile = (tags: string[]) =>
  FabFile.create({
    userId: ownerId,
    fileName: 'seed.txt',
    type: KnowledgeType.FILE,
    mimeType: 'text/plain',
    status: 'complete',
    tags: tags.map(name => ({ name, strength: 1 })),
    users: [{ userId: editorId, permissions: [Permission.read, Permission.update] }],
  });

const storage = {
  upload: async () => ({}),
  generateSignedUrl: async () => 'https://example.test/signed',
};

describe('reconcileLakeTags (via updateFabFile) against real Mongo', () => {
  it('drops the prefix tag, clears membership, and recomputes stats to 0', async () => {
    const lake = await makeLake();
    const file = await makeFile(['lk:invoices']);
    const user = { id: ownerId, isAdmin: false } as any;

    await fabFilesService.updateFabFile(
      user,
      { id: file.id as string, tags: [] },
      { db: { fabFiles: fabFileRepository, dataLakes: dataLakeRepository }, storage }
    );

    const persistedFile = await FabFile.findById(file.id);
    expect(persistedFile?.tags ?? []).toEqual([]);
    const persistedLake = await DataLakeModel.findById(lake.id);
    expect(persistedLake?.fileCount).toBe(0);
  }, 30000);

  it('refuses a shared editor who is not the lake creator, persisting nothing', async () => {
    await makeLake();
    const file = await makeFile(['lk:invoices']);
    const editor = { id: editorId, isAdmin: false } as any;

    await expect(
      fabFilesService.updateFabFile(
        editor,
        { id: file.id as string, tags: [] },
        { db: { fabFiles: fabFileRepository, dataLakes: dataLakeRepository }, storage }
      )
    ).rejects.toThrow(/only the creator can remove/i);

    const persistedFile = await FabFile.findById(file.id);
    expect((persistedFile?.tags ?? []).map(t => t.name)).toEqual(['lk:invoices']);
  }, 30000);

  // A prefix-arm JOIN needs no manage-rights gate on the membership itself (the read-side
  // predicate grants it purely on the tag), but recomputeLakeStats also flips a draft lake to
  // active - a one-way publication change. A shared editor tagging the OWNER's file with the
  // OWNER's own lake prefix must not be able to force-publish a lake they have no relationship to.
  it('does not publish a draft lake when a shared editor triggers the join', async () => {
    const lake = await makeLake({ status: 'draft', fileCount: 0, totalSizeBytes: 0 });
    const file = await makeFile([]);
    const editor = { id: editorId, isAdmin: false } as any;

    await fabFilesService.updateFabFile(
      editor,
      { id: file.id as string, tags: [{ name: 'lk:invoices', strength: 1 }] },
      { db: { fabFiles: fabFileRepository, dataLakes: dataLakeRepository }, storage }
    );

    const persistedLake = await DataLakeModel.findById(lake.id);
    expect(persistedLake?.status).toBe('draft');
    expect(persistedLake?.fileCount).toBe(0);
  }, 30000);

  it('publishes a draft lake when the OWNER triggers the same join', async () => {
    const lake = await makeLake({ status: 'draft', fileCount: 0, totalSizeBytes: 0 });
    const file = await makeFile([]);
    const owner = { id: ownerId, isAdmin: false } as any;

    await fabFilesService.updateFabFile(
      owner,
      { id: file.id as string, tags: [{ name: 'lk:invoices', strength: 1 }] },
      { db: { fabFiles: fabFileRepository, dataLakes: dataLakeRepository }, storage }
    );

    const persistedLake = await DataLakeModel.findById(lake.id);
    expect(persistedLake?.status).toBe('active');
    expect(persistedLake?.fileCount).toBe(1);
  }, 30000);
});

describe('toggleTags against real Mongo', () => {
  it('drops the prefix tag, clears membership, and recomputes stats to 0', async () => {
    const lake = await makeLake();
    const file = await makeFile(['lk:invoices']);

    await fabFilesService.toggleTags(
      ownerId,
      { ids: [file.id], tags: ['lk:invoices'] },
      {
        db: {
          fabFiles: fabFileRepository,
          fileTags: fileTagRepository,
          dataLakes: dataLakeRepository,
          users: userRepository,
        },
      }
    );

    const persistedFile = await FabFile.findById(file.id);
    expect(persistedFile?.tags ?? []).toEqual([]);
    const persistedLake = await DataLakeModel.findById(lake.id);
    expect(persistedLake?.fileCount).toBe(0);
  }, 30000);

  it('refuses a shared editor who is not the lake creator, persisting nothing in the batch', async () => {
    await makeLake();
    const file = await makeFile(['lk:invoices']);

    await expect(
      fabFilesService.toggleTags(
        editorId,
        { ids: [file.id], tags: ['lk:invoices'] },
        {
          db: {
            fabFiles: fabFileRepository,
            fileTags: fileTagRepository,
            dataLakes: dataLakeRepository,
            users: userRepository,
          },
        }
      )
    ).rejects.toThrow(/only the creator can remove/i);

    const persistedFile = await FabFile.findById(file.id);
    expect((persistedFile?.tags ?? []).map(t => t.name)).toEqual(['lk:invoices']);
  }, 30000);

  it('does not publish a draft lake when a shared editor triggers the join', async () => {
    const lake = await makeLake({ status: 'draft', fileCount: 0, totalSizeBytes: 0 });
    const file = await makeFile([]);

    await fabFilesService.toggleTags(
      editorId,
      { ids: [file.id], tags: ['lk:invoices'] },
      {
        db: {
          fabFiles: fabFileRepository,
          fileTags: fileTagRepository,
          dataLakes: dataLakeRepository,
          users: userRepository,
        },
      }
    );

    const persistedLake = await DataLakeModel.findById(lake.id);
    expect(persistedLake?.status).toBe('draft');
    expect(persistedLake?.fileCount).toBe(0);
  }, 30000);
});
