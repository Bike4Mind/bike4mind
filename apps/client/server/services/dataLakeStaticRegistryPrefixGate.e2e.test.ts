import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { KnowledgeType } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  FabFile,
  User,
  dataLakeRepository,
  fabFileRepository,
  fileTagRepository,
  userRepository,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';

/**
 * End-to-end guard, against REAL Mongo rather than a mock, for the static-registry namespace gate
 * (e.g. `opti:`): those lakes have no owning document, so `canManageLake` and the prefix-arm
 * membership checks - both anchored to a lake's `createdByUserId` - never see them, and only an
 * admin-role check can catch a caller self-applying one. Drives BOTH single-file write doors
 * (element-level toggle and whole-array update) through the REAL FabFile repository so a mock
 * disagreeing with the real schema (e.g. `isAdmin` not actually persisting) can't hide a gap.
 * Lives in apps/client because it is the only package with both @bike4mind/services and
 * @bike4mind/database as dependencies. Consumes the built dist, so `pnpm turbo:core:build` must
 * be current.
 */

let mongoServer: MongoMemoryServer;
let ownerId: string;
let adminId: string;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  const owner = await User.create({ username: 'file-owner', name: 'Owner', isAdmin: false });
  const admin = await User.create({ username: 'platform-admin', name: 'Admin', isAdmin: true });
  ownerId = owner.id as string;
  adminId = admin.id as string;
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);
afterEach(async () => {
  await FabFile.deleteMany({});
});

const makeFile = (tags: { name: string; strength?: number }[] = [], userId = ownerId) =>
  FabFile.create({
    userId,
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: 'notes.txt',
    fileSize: 10,
    status: 'complete',
    tags: tags.map(t => ({ name: t.name, strength: t.strength ?? 1 })),
  });

const toggleAdapters = {
  db: {
    fabFiles: fabFileRepository,
    fileTags: fileTagRepository,
    dataLakes: dataLakeRepository,
    users: userRepository,
  },
};

const updateAdapters = {
  db: { fabFiles: fabFileRepository, dataLakes: dataLakeRepository },
  storage: {
    upload: async () => 'unused',
    generateSignedUrl: async () => 'unused',
  },
};

describe('data-lake static-registry prefix gate (real Mongo, both single-file doors)', () => {
  describe('toggleTags', () => {
    it('refuses a non-admin newly applying a static-registry-prefixed tag', async () => {
      const file = await makeFile();

      await expect(
        fabFilesService.toggleTags(ownerId, { ids: [file.id], tags: ['opti:report'] }, toggleAdapters)
      ).rejects.toThrow(/only an admin can change this data lake/i);

      const persisted = await FabFile.findById(file.id);
      expect(persisted?.tags ?? []).toEqual([]);
    }, 30000);

    it('allows an admin to apply a static-registry-prefixed tag', async () => {
      const file = await makeFile([], adminId);

      await fabFilesService.toggleTags(adminId, { ids: [file.id], tags: ['opti:report'] }, toggleAdapters);

      const persisted = await FabFile.findById(file.id);
      expect((persisted?.tags ?? []).map(t => t.name)).toEqual(['opti:report']);
    }, 30000);

    it('allows a non-admin to remove a legacy static-registry-prefixed tag already on their file', async () => {
      const file = await makeFile([{ name: 'opti:legacy' }]);

      await fabFilesService.toggleTags(ownerId, { ids: [file.id], tags: ['opti:legacy'] }, toggleAdapters);

      const persisted = await FabFile.findById(file.id);
      expect(persisted?.tags ?? []).toEqual([]);
    }, 30000);
  });

  describe('updateFabFile (whole-array PUT /api/files/[id] path)', () => {
    it('refuses a non-admin whole-array write that newly adds a static-registry-prefixed tag', async () => {
      const file = await makeFile();
      const user = await User.findById(ownerId);

      await expect(
        fabFilesService.updateFabFile(
          user!,
          { id: file.id, tags: [{ name: 'opti:report', strength: 1 }] },
          updateAdapters
        )
      ).rejects.toThrow(/only an admin can change this data lake/i);

      const persisted = await FabFile.findById(file.id);
      expect(persisted?.tags ?? []).toEqual([]);
    }, 30000);

    it('does not block an unrelated edit to a file that already carries a legacy static-registry-prefixed tag', async () => {
      const file = await makeFile([{ name: 'opti:legacy' }]);
      const user = await User.findById(ownerId);

      await fabFilesService.updateFabFile(
        user!,
        {
          id: file.id,
          tags: [
            { name: 'opti:legacy', strength: 1 },
            { name: 'unrelated', strength: 1 },
          ],
        },
        updateAdapters
      );

      const persisted = await FabFile.findById(file.id);
      expect((persisted?.tags ?? []).map(t => t.name).sort()).toEqual(['opti:legacy', 'unrelated']);
    }, 30000);

    it('allows an admin whole-array write that newly adds a static-registry-prefixed tag', async () => {
      const file = await makeFile([], adminId);
      const admin = await User.findById(adminId);

      await fabFilesService.updateFabFile(
        admin!,
        { id: file.id, tags: [{ name: 'opti:report', strength: 1 }] },
        updateAdapters
      );

      const persisted = await FabFile.findById(file.id);
      expect((persisted?.tags ?? []).map(t => t.name)).toEqual(['opti:report']);
    }, 30000);
  });
});
