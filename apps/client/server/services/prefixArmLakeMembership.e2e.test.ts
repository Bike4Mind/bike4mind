import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { KnowledgeType, Permission } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  DataLakeModel,
  DataLakeAccessGrantModel,
  LakeMembershipRemovalModel,
  FabFile,
  User,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  lakeMembershipRemovalRepository,
  adminSettingsRepository,
  fabFileRepository,
  fileTagRepository,
  userRepository,
} from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * End-to-end guard, against REAL Mongo rather than a mock, for a file whose ONLY lake membership
 * signal is a `fileTagPrefix` content tag (no `datalake:*` meta-tag): removal is gated and stats-
 * recomputed exactly like a meta-tag leave, but ONLY through the tag-toggle door
 * (`fabFilesService.toggleTags`, an explicit single-tag action). The whole-array write door
 * (`updateFabFile`, the shape `PUT /api/files/:id` sends) can never remove this membership at
 * all - a whole array cannot distinguish an intentional drop from a stale client's copy, so it
 * preserves the tag instead. A mock can assert `removeFileFromLake` was (or wasn't) called; only
 * a real aggregate proves the actual persisted state and stats. Lives in apps/client because it
 * is the only package with both @bike4mind/services and @bike4mind/database as dependencies.
 * Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;
let ownerId: string;
let editorId: string;
let curatorId: string;
let transferredOwnerId: string;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  const owner = await User.create({ username: 'lake-owner', name: 'Owner' });
  const editor = await User.create({ username: 'shared-editor', name: 'Editor' });
  const curator = await User.create({ username: 'lake-curator', name: 'Curator' });
  const transferredOwner = await User.create({ username: 'new-owner', name: 'New Owner' });
  ownerId = owner.id as string;
  editorId = editor.id as string;
  curatorId = curator.id as string;
  transferredOwnerId = transferredOwner.id as string;
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await FabFile.deleteMany({});
  await DataLakeModel.deleteMany({});
  await DataLakeAccessGrantModel.deleteMany({});
  await LakeMembershipRemovalModel.deleteMany({});
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
  // The headline bug this ticket fixes: a whole-array write (here, dropping every tag) must
  // preserve prefix-arm membership rather than reading the absence as an intentional leave.
  it('preserves the prefix tag and membership when the caller drops it via a whole-array write', async () => {
    const lake = await makeLake();
    const file = await makeFile(['lk:invoices']);
    const user = { id: ownerId, isAdmin: false } as any;

    await fabFilesService.updateFabFile(
      user,
      { id: file.id as string, tags: [] },
      { db: { fabFiles: fabFileRepository, dataLakes: dataLakeRepository }, storage }
    );

    const persistedFile = await FabFile.findById(file.id);
    expect((persistedFile?.tags ?? []).map(t => t.name)).toEqual(['lk:invoices']);
    const persistedLake = await DataLakeModel.findById(lake.id);
    expect(persistedLake?.fileCount).toBe(1);
  });

  it('preserves membership on a whole-array drop regardless of manage rights', async () => {
    await makeLake();
    const file = await makeFile(['lk:invoices']);
    const editor = { id: editorId, isAdmin: false } as any;

    await fabFilesService.updateFabFile(
      editor,
      { id: file.id as string, tags: [] },
      { db: { fabFiles: fabFileRepository, dataLakes: dataLakeRepository }, storage }
    );

    const persistedFile = await FabFile.findById(file.id);
    expect((persistedFile?.tags ?? []).map(t => t.name)).toEqual(['lk:invoices']);
  });

  // A prefix-arm JOIN needs no manage-rights gate on the membership itself (the read-side
  // predicate grants it purely on the tag), but recomputeLakeStats's activation side effect
  // also flips a draft lake to active - a one-way publication change. A shared editor tagging
  // the OWNER's file with the OWNER's own lake prefix must not be able to force-publish a lake
  // they have no relationship to. Stats still get corrected (real aggregate, not a mock) so they
  // don't drift until some other door happens to touch this lake again.
  it('corrects a draft lake stats without publishing it when a shared editor triggers the join', async () => {
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
    expect(persistedLake?.fileCount).toBe(1);
  });

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
  });
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
  });

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
    ).rejects.toThrow(/do not have permission to remove/i);

    const persistedFile = await FabFile.findById(file.id);
    expect((persistedFile?.tags ?? []).map(t => t.name)).toEqual(['lk:invoices']);
  });

  it('corrects a draft lake stats without publishing it when a shared editor triggers the join', async () => {
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
    expect(persistedLake?.fileCount).toBe(1);
  });
});

/**
 * The AC regression for #2248: "a platform admin [or any lake manager] can reverse any
 * lake-member removal they are able to perform." Against real Mongo because the whole point is
 * the PERSISTED tag state after a real remove -> restore round trip, not whether a mock was
 * called - a mock can assert removeFileFromLake fired; only the aggregate proves the file landed
 * back on its ORIGINAL tag node rather than <prefix>uncategorized.
 */
describe('restore after removal (#2248) against real Mongo', () => {
  const removeDb = {
    dataLakes: dataLakeRepository,
    fabFiles: fabFileRepository,
    dataLakeAccessGrants: dataLakeAccessGrantRepository,
    lakeMembershipRemovals: lakeMembershipRemovalRepository,
    adminSettings: adminSettingsRepository,
  };
  const addDb = removeDb;

  it('a non-owner curator removes a creator-owned member, then restores it to its ORIGINAL tag node', async () => {
    const lake = await makeLake();
    const file = await makeFile(['lk:invoices']);
    await dataLakeAccessGrantRepository.upsertGrant({
      dataLakeId: lake.id as string,
      principalType: 'user',
      principalId: curatorId,
      role: 'curator',
      grantedByUserId: ownerId,
    });
    const curator = { userId: curatorId, isAdmin: false };

    // The exact persona the issue's AC names: a curator grant is not an `owner` grant, so this
    // actor is NOT an effective owner (resolveEffectiveOwnerIds counts only role: 'owner') and the
    // cold-add branch refuses them. So reaching the original tag node below can only be the restore
    // path - the record is what admits them, and the record is what carries `lk:invoices` back.
    await dataLakeService.removeFileFromDataLake(curator, lake.id as string, file.id as string, { db: removeDb });
    const afterRemoval = await FabFile.findById(file.id);
    expect((afterRemoval?.tags ?? []).map(t => t.name)).toEqual([]);

    const result = await dataLakeService.addFileToDataLake(curator, lake.id as string, file.id as string, {
      db: addDb,
    });
    expect(result.success).toBe(true);

    const restored = await FabFile.findById(file.id);
    const names = (restored?.tags ?? []).map(t => t.name);
    // The whole point of step 0: back on its real node, not a placeholder.
    expect(names).toContain('lk:invoices');
    expect(names).not.toContain('lk:uncategorized');
  });

  it('stops working once the removal record expires - the restore falls back to the cold-add ownership guard', async () => {
    const lake = await makeLake();
    // A THIRD PARTY's file (not the lake owner's own library), so the cold-add path's "any
    // manager may re-add the lake owner's own files" allowance does not mask the refusal this
    // test is actually checking.
    const stranger = await User.create({ username: 'stranger-2', name: 'Stranger Two' });
    const file = await FabFile.create({
      userId: stranger.id,
      fileName: 'stranger-file.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      status: 'complete',
      tags: [
        { name: 'datalake:lake', strength: 1 },
        { name: 'lk:invoices', strength: 1 },
      ],
      users: [{ userId: ownerId, permissions: [Permission.read, Permission.update] }],
    });
    const owner = { userId: ownerId, isAdmin: false };

    await dataLakeService.removeFileFromDataLake(owner, lake.id as string, file.id as string, { db: removeDb });
    // Simulate the TTL having elapsed: backdate the record's expiry directly (the sweeper itself
    // is not under test here - the lookup's own expiresAt filter is).
    await LakeMembershipRemovalModel.updateOne(
      { dataLakeId: lake.id, fabFileId: file.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    // The owner can manage the lake but does not own this stranger's file (and the file's own
    // owner is not the lake's effective owner either), so once the record is gone the cold-add
    // ownership guard refuses them.
    await expect(
      dataLakeService.addFileToDataLake(owner, lake.id as string, file.id as string, { db: addDb })
    ).rejects.toThrow(/file not found/i);
  });

  it('a lake owner transferred BY GRANT restores a pre-transfer member the original creator can no longer reach', async () => {
    const lake = await makeLake(); // createdByUserId stays ownerId - transfer never mutates it
    const file = await makeFile(['lk:invoices']); // owned by ownerId, the pre-transfer creator
    await dataLakeAccessGrantRepository.upsertGrant({
      dataLakeId: lake.id as string,
      principalType: 'user',
      principalId: transferredOwnerId,
      role: 'owner',
      grantedByUserId: ownerId,
    });
    const newOwner = { userId: transferredOwnerId, isAdmin: false };

    // Round-1's ownership guard resolved effective owners as [transferredOwnerId] (grants
    // supersede the creator), which does not include the file's own owner (ownerId) - so the
    // restore would have 404'd for exactly this actor on exactly this file.
    await dataLakeService.removeFileFromDataLake(newOwner, lake.id as string, file.id as string, { db: removeDb });

    const result = await dataLakeService.addFileToDataLake(newOwner, lake.id as string, file.id as string, {
      db: addDb,
    });
    expect(result.success).toBe(true);
    const restored = await FabFile.findById(file.id);
    expect((restored?.tags ?? []).map(t => t.name)).toContain('lk:invoices');
  });

  it('restores a third-party-owned, meta-tag-only member with empty contentTags under uncategorized', async () => {
    const lake = await makeLake();
    // A stranger's file admitted to the lake by meta-tag alone (an admin's earlier addFileToLake,
    // not through the gated cold-add door) - the population `contentTags` is legitimately empty
    // for, per lakeMembershipSignals' ownsFile conjunct.
    const stranger = await User.create({ username: 'stranger', name: 'Stranger' });
    const file = await FabFile.create({
      userId: stranger.id,
      fileName: 'shared.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      status: 'complete',
      tags: [{ name: 'datalake:lake', strength: 1 }],
    });
    const admin = { userId: ownerId, isAdmin: true };

    await dataLakeService.removeFileFromDataLake(admin, lake.id as string, file.id as string, { db: removeDb });
    const afterRemoval = await FabFile.findById(file.id);
    expect((afterRemoval?.tags ?? []).map(t => t.name)).toEqual([]);

    const result = await dataLakeService.addFileToDataLake(admin, lake.id as string, file.id as string, {
      db: addDb,
    });
    expect(result.success).toBe(true);
    const restored = await FabFile.findById(file.id);
    const names = (restored?.tags ?? []).map(t => t.name);
    expect(names).toContain('datalake:lake');
    expect(names).toContain('lk:uncategorized');
  });
});

/**
 * The AC regression for #2255: "a lake manager can repair categorization inside a lake they
 * manage, on a file they do not own, with no removal record present." Against real Mongo for the
 * same reason as #2248's suite above - only the persisted aggregate proves the write, not that a
 * mocked repository method was called.
 */
describe('setDataLakeFileTags (#2255) against real Mongo', () => {
  const tagsDb = {
    dataLakes: dataLakeRepository,
    fabFiles: fabFileRepository,
    dataLakeAccessGrants: dataLakeAccessGrantRepository,
    adminSettings: adminSettingsRepository,
  };

  it('the AC: a curator grant, a creator-owned member, and NO removal record replaces the tag set', async () => {
    const lake = await makeLake();
    const file = await makeFile(['lk:uncategorized']);
    await dataLakeAccessGrantRepository.upsertGrant({
      dataLakeId: lake.id as string,
      principalType: 'user',
      principalId: curatorId,
      role: 'curator',
      grantedByUserId: ownerId,
    });
    const curator = { userId: curatorId, isAdmin: false };

    // No LakeMembershipRemoval exists at all - the exact hole #2255 is about, distinct from
    // #2248's "restore within the TTL" story above.
    const result = await dataLakeService.setDataLakeFileTags(
      curator,
      lake.id as string,
      file.id as string,
      ['lk:invoices', 'lk:reports'],
      { db: tagsDb }
    );

    expect(result.success).toBe(true);
    const persisted = await FabFile.findById(file.id);
    const names = (persisted?.tags ?? []).map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['lk:invoices', 'lk:reports']));
    expect(names).not.toContain('lk:uncategorized');
    const persistedLake = await DataLakeModel.findById(lake.id);
    expect(persistedLake?.fileCount).toBe(1);
  });

  it('on a third-party-owned member, a stale caller-authored tag is retained but the stale placeholder is shed', async () => {
    const lake = await makeLake();
    const stranger = await User.create({ username: 'stranger-tags', name: 'Stranger' });
    const file = await FabFile.create({
      userId: stranger.id,
      fileName: 'shared.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      status: 'complete',
      tags: [
        { name: 'datalake:lake', strength: 1 },
        { name: 'lk:stale', strength: 1 },
        { name: 'lk:uncategorized', strength: 1 },
      ],
    });
    const admin = { userId: ownerId, isAdmin: true };

    const result = await dataLakeService.setDataLakeFileTags(
      admin,
      lake.id as string,
      file.id as string,
      ['lk:fresh'],
      {
        db: tagsDb,
      }
    );

    expect(result.success).toBe(true);
    expect(result.tags.retained).toEqual(['lk:stale']);
    expect(result.tags.removed).toEqual(['lk:uncategorized']);
    const names = ((await FabFile.findById(file.id))?.tags ?? []).map(t => t.name);
    expect(names).toContain('lk:stale');
    expect(names).toContain('lk:fresh');
    expect(names).not.toContain('lk:uncategorized');
  });

  it('refuses to empty a prefix-only member, leaving its tags unchanged', async () => {
    const lake = await makeLake();
    const file = await makeFile(['lk:invoices']);
    const admin = { userId: ownerId, isAdmin: true };

    await expect(
      dataLakeService.setDataLakeFileTags(admin, lake.id as string, file.id as string, [], { db: tagsDb })
    ).rejects.toThrow(/would remove the file from/i);

    const names = ((await FabFile.findById(file.id))?.tags ?? []).map(t => t.name);
    expect(names).toEqual(['lk:invoices']);
  });

  it('mints the uncategorized placeholder when a meta-tag member is emptied to nothing', async () => {
    const lake = await makeLake();
    const stranger = await User.create({ username: 'stranger-empty', name: 'Stranger' });
    const file = await FabFile.create({
      userId: stranger.id,
      fileName: 'meta-only.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      status: 'complete',
      tags: [{ name: 'datalake:lake', strength: 1 }],
    });
    const admin = { userId: ownerId, isAdmin: true };

    const result = await dataLakeService.setDataLakeFileTags(admin, lake.id as string, file.id as string, [], {
      db: tagsDb,
    });

    expect(result.success).toBe(true);
    const names = ((await FabFile.findById(file.id))?.tags ?? []).map(t => t.name);
    expect(names).toContain('datalake:lake');
    expect(names).toContain('lk:uncategorized');
  });

  it('unsets primaryTag when the tag it names is pulled', async () => {
    const lake = await makeLake();
    const file = await makeFile(['lk:stale']);
    await FabFile.updateOne({ _id: file.id }, { $set: { primaryTag: 'lk:stale' } });
    const admin = { userId: ownerId, isAdmin: true };

    await dataLakeService.setDataLakeFileTags(admin, lake.id as string, file.id as string, ['lk:fresh'], {
      db: tagsDb,
    });

    const persisted = await FabFile.findById(file.id);
    expect(persisted?.primaryTag).toBeFalsy();
  });
});
