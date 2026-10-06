import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile, Session, User, withTransaction } from '@bike4mind/database';
import { notebookImportService } from '@bike4mind/services';
import { createChatHistoryWrites, createSessionWrites } from './notebookImportComplete';
import { chargeImportedKnowledgeStorage, claimStorageCharge } from './storageCharge';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * The import's quota gate reads `currentStorageSize`, and nothing on the import path used to charge
 * it, so every import measured against the same headroom. Drives the REAL service (built dist - run
 * `pnpm --filter @bike4mind/services build` first) against a replica set, since the charge joins the
 * import's transaction.
 */

const { NotebookImportService } = notebookImportService;

const USER_ID = new mongoose.Types.ObjectId();
const USER = USER_ID.toString();
// storageLimit is in MB, so the quota is 1,000,000 bytes.
const STORAGE_LIMIT_MB = 1;
const FILE_BYTES = 600_000;

let replSet: Awaited<ReturnType<typeof createMongoReplSet>> | undefined;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
afterEach(async () => {
  await Promise.all([
    FabFile.deleteMany({}, { hardDelete: true }),
    Session.deleteMany({}, { hardDelete: true }),
    User.collection.deleteMany({}),
  ]);
});

// Raw insert: the import only reads the two quota fields, and the full schema's required fields
// are irrelevant here.
const seedUser = () =>
  User.collection.insertOne({ _id: USER_ID, storageLimit: STORAGE_LIMIT_MB, currentStorageSize: 0 });

const storedSize = async () => (await User.collection.findOne({ _id: USER_ID }))?.currentStorageSize;

const payload = (name: string) => ({
  exportVersion: '1.0.0',
  notebooks: [
    {
      id: name,
      name,
      firstCreated: '2026-01-01T00:00:00.000Z',
      lastUpdated: '2026-01-02T00:00:00.000Z',
      chatHistory: [],
      knowledge: [
        {
          id: `${name}-file`,
          name: `${name}.bin`,
          mimeType: 'application/octet-stream',
          size: FILE_BYTES,
          content: Buffer.alloc(FILE_BYTES, 1).toString('base64'),
          type: 'FILE',
        },
      ],
      artifacts: [],
      tools: [],
      agents: [],
    },
  ],
});

const OPTIONS = {
  importKnowledge: true,
  importArtifacts: false,
  importTools: false,
  importAgents: false,
  conflictResolution: 'rename',
  preserveIds: false,
};

const makeService = () =>
  new NotebookImportService({
    sessionRepository: createSessionWrites(),
    chatHistoryRepository: createChatHistoryWrites(),
    knowledgeRepository: { create: async (d: Record<string, unknown>) => (await FabFile.create([d]))[0] },
    artifactIdTaken: async () => false,
    createArtifact: async () => null,
    toolRepository: { create: async () => null },
    agentRepository: { create: async () => null },
    userRepository: { findById: async (id: string) => User.findById(id) },
    adminSettings: { findAll: async () => [], findBySettingNames: async () => [] },
    fileStorageService: { uploadFile: async () => {}, deleteFile: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    generateId: () => new mongoose.Types.ObjectId().toString(),
  } as never);

/** One import as notebookImportComplete runs it: the import and its charge in one transaction. */
const importAndCharge = (name: string) =>
  withTransaction(async session => {
    const result = await makeService().importNotebooks(USER, payload(name) as never, OPTIONS as never);
    await chargeImportedKnowledgeStorage(USER, result.importedKnowledgeFilePaths ?? [], session);
    return result;
  });

describe('notebook import storage charge', () => {
  it('does not admit a second import that only fit the headroom the first one spent', async () => {
    await seedUser();

    const first = await importAndCharge('first');
    const second = await importAndCharge('second');

    expect(first.importedAttachments).toBe(1);
    expect(second.importedAttachments).toBe(0);
    expect(second.warnings?.join(' ')).toMatch(/storage limit/);
    expect(await FabFile.countDocuments({ userId: USER })).toBe(1);
    expect(await storedSize()).toBe(FILE_BYTES);
  });

  it('leaves the S3 event for the imported upload nothing to charge', async () => {
    await seedUser();
    const uploadedAt = new Date(Date.now() - 1000);
    await importAndCharge('charged');
    const row = await FabFile.findOne({ userId: USER });

    expect(await claimStorageCharge(row?._id, uploadedAt)).toBe(false);
  });

  it('still charges a later rewrite of an imported file', async () => {
    await seedUser();
    await importAndCharge('rewritten');
    const row = await FabFile.findOne({ userId: USER });

    expect(await claimStorageCharge(row?._id, new Date(Date.now() + 1000))).toBe(true);
  });

  it('charges a redelivered S3 event once', async () => {
    const [row] = await FabFile.create([
      { userId: USER, fileName: 'x', mimeType: 'text/plain', fileSize: 5, filePath: 'knowledge/x', type: 'FILE' },
    ]);
    const uploadedAt = new Date();

    expect(await claimStorageCharge(row._id, uploadedAt)).toBe(true);
    expect(await claimStorageCharge(row._id, uploadedAt)).toBe(false);
  });

  it('charges nothing when the transaction rolls back', async () => {
    await seedUser();

    await expect(
      withTransaction(async session => {
        const result = await makeService().importNotebooks(USER, payload('rolled') as never, OPTIONS as never);
        await chargeImportedKnowledgeStorage(USER, result.importedKnowledgeFilePaths ?? [], session);
        throw new Error('abort');
      })
    ).rejects.toThrow('abort');

    expect(await storedSize()).toBe(0);
  });

  it("never charges another user's row that shares a path", async () => {
    await seedUser();
    const other = new mongoose.Types.ObjectId().toString();
    await FabFile.create([
      { userId: other, fileName: 'x', mimeType: 'text/plain', fileSize: 5, filePath: 'knowledge/x', type: 'FILE' },
    ]);

    expect(await withTransaction(session => chargeImportedKnowledgeStorage(USER, ['knowledge/x'], session))).toBe(0);
  });
});
