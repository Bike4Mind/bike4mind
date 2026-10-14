import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { STORAGE_CHARGE_STAMP_CUTOFF } from '@bike4mind/common';
import { FabFile, Session, User, fabFileRepository, userRepository, withTransaction } from '@bike4mind/database';
import { fabFilesService, notebookImportService } from '@bike4mind/services';
import { createChatHistoryWrites, createSessionWrites } from './notebookImportComplete';
import {
  chargeStampedKnowledgeStorage,
  chargeUploadedObject,
  claimStorageCharge,
  stampImportedKnowledgeRows,
} from './storageCharge';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * The import's quota gate reads `currentStorageSize`, and nothing on the import path used to charge
 * it, so every import measured against the same headroom. Drives the REAL service (built dist - run
 * `pnpm --filter @bike4mind/services build` first) against a replica set, since the row stamp joins the
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
  // No assertion here depends on a schema index (the claims are compare-and-set updates), so skip the
  // builds and settle the collection creates before the first transaction. See settleAutoIndexBuilds
  // in createMongoServer.ts for the pool deadlock this avoids.
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
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
const BASELINE_BYTES = 100_000;
const seedUser = () =>
  User.collection.insertOne({ _id: USER_ID, storageLimit: STORAGE_LIMIT_MB, currentStorageSize: BASELINE_BYTES });

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

/** One import as notebookImportComplete runs it: stamp in the transaction, debit after commit. */
const importAndCharge = async (name: string) => {
  let stamp: Date | undefined;
  const result = await withTransaction(async session => {
    const imported = await makeService().importNotebooks(USER, payload(name) as never, OPTIONS as never);
    stamp = await stampImportedKnowledgeRows(USER, imported.importedKnowledgeFilePaths ?? [], session);
    return imported;
  });
  await chargeStampedKnowledgeStorage(USER, result.importedKnowledgeFilePaths ?? [], stamp as Date);
  return result;
};

const rewriteDb = { fabFiles: fabFileRepository, users: userRepository };

const tick = () => new Promise(resolve => setTimeout(resolve, 2));

/** One S3 event as objectCreated charges it. Returns what it charged, or null when its claim lost. */
const s3Event = async (fabFileId: unknown, eventTime: Date, size: number) => {
  const charged = await claimStorageCharge(fabFileId as string, eventTime, size);
  if (charged) await userRepository.incrementCurrentStorage(USER, charged);
  return charged;
};

/**
 * A content rewrite as every rewrite site runs it, with the S3 upload elided. Returns the upload's
 * S3 eventTime, which falls between the upload starting and the commit.
 */
const rewrite = async (fabFileId: string, newSize: number, beforeCommit?: (eventTime: Date) => Promise<void>) => {
  await tick();
  const eventTime = new Date();
  await tick();
  await beforeCommit?.(eventTime);
  await fabFilesService.commitContentRewrite({ fabFileId, newSize }, rewriteDb);
  return eventTime;
};

/** The first upload as objectCreated charges it. */
const firstUpload = async (fileSize: number) => {
  const [row] = await FabFile.create([
    { userId: USER, fileName: 'x', mimeType: 'text/plain', fileSize, filePath: 'files/x', type: 'FILE' },
  ]);
  await s3Event(row._id, new Date(), fileSize);
  return String(row._id);
};

/**
 * A file the S3 handler charged before rows were stamped: complete (or, older still, with no status
 * at all), unstamped, created pre-cutoff.
 */
const legacyFile = async (fileSize: number, { noStatus = false } = {}) => {
  const [row] = await FabFile.create([
    { userId: USER, fileName: 'x', mimeType: 'text/plain', fileSize, filePath: 'files/x', type: 'FILE' },
  ]);
  const createdAt = new Date(STORAGE_CHARGE_STAMP_CUTOFF.getTime() - 1000);
  await FabFile.collection.updateOne(
    { _id: row._id },
    noStatus ? { $set: { createdAt }, $unset: { status: 1 } } : { $set: { status: 'complete', createdAt } }
  );
  await userRepository.incrementCurrentStorage(USER, fileSize);
  return String(row._id);
};

describe('content rewrite storage charge', () => {
  const truth = async () => BASELINE_BYTES + (await fabFileRepository.sumFileSizeByUserId(USER));

  it('keeps the counter equal to the stored sizes across growing and shrinking rewrites, and a delete', async () => {
    await seedUser();
    const id = await firstUpload(100);
    expect(await storedSize()).toBe(await truth());

    for (const size of [300, 50, 50, 900]) {
      const eventTime = await rewrite(id, size);
      // The rewrite's own S3 event, and any redelivery of it, claims nothing.
      expect(await s3Event(id, eventTime, size)).toBeNull();
      expect(await storedSize()).toBe(await truth());
    }
    expect(await storedSize()).toBe(BASELINE_BYTES + 900);

    // Mirrors the delete path's refund of the stored size.
    await FabFile.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
    await userRepository.incrementCurrentStorage(USER, -900);
    expect(await storedSize()).toBe(await truth());
  });

  it('ends at the truth when the S3 event is processed before the rewrite commits', async () => {
    await seedUser();
    const id = await firstUpload(100);

    await rewrite(id, 400, async eventTime => {
      // objectCreated sees the new object first: it records the new size and charges the difference.
      expect(await s3Event(id, eventTime, 400)).toBe(300);
    });

    expect(await storedSize()).toBe(BASELINE_BYTES + 400);
    expect(await storedSize()).toBe(await truth());
  });

  it('charges a rewrite of a legacy unstamped file only the delta', async () => {
    await seedUser();
    const id = await legacyFile(5000);

    const eventTime = await rewrite(id, 5100);
    await s3Event(id, eventTime, 5100);

    expect(await storedSize()).toBe(BASELINE_BYTES + 5100);
    expect(await storedSize()).toBe(await truth());
  });

  it('charges a legacy rewrite only the delta when its S3 event is processed before the commit', async () => {
    await seedUser();
    const id = await legacyFile(5000);

    await rewrite(id, 5100, async eventTime => {
      expect(await s3Event(id, eventTime, 5100)).toBe(100);
    });

    expect(await storedSize()).toBe(BASELINE_BYTES + 5100);
    expect(await storedSize()).toBe(await truth());
  });

  it('counts a legacy file with no status as charged', async () => {
    await seedUser();
    const id = await legacyFile(1000, { noStatus: true });
    expect(await storedSize()).toBe(await truth());

    for (const size of [1000, 1500]) {
      const eventTime = await rewrite(id, size);
      await s3Event(id, eventTime, size);
      expect(await storedSize()).toBe(BASELINE_BYTES + size);
      expect(await storedSize()).toBe(await truth());
    }
  });

  it.each([
    ['complete', false, 'complete'],
    ['no-status', true, 'pending'],
  ])('never refuses a shrink of a legacy %s unstamped file near the quota', async (_label, noStatus, readStatus) => {
    await seedUser();
    const id = await legacyFile(850_000, { noStatus });
    // Rewrite sites pass a hydrated row, which reports a missing status as its 'pending' default.
    const row = await FabFile.findById(id);
    expect(row?.status).toBe(readStatus);
    const owner = await User.findById(USER_ID);

    await expect(
      fabFilesService.assertRewriteFits(row as never, 800_000, rewriteDb, owner as never)
    ).resolves.toBeUndefined();
  });

  it('keeps the counter at the truth when two rewrites of one file overlap, in either event order', async () => {
    await seedUser();
    const id = await firstUpload(1000);

    // A (-> 2000) and B (-> 3000) both upload before A commits; neither event claims after the commits.
    const eventA = new Date();
    await tick();
    const eventB = new Date();
    await tick();
    await fabFilesService.commitContentRewrite({ fabFileId: id, newSize: 2000 }, rewriteDb);
    await fabFilesService.commitContentRewrite({ fabFileId: id, newSize: 3000 }, rewriteDb);
    expect(await s3Event(id, eventA, 2000)).toBeNull();
    expect(await s3Event(id, eventB, 3000)).toBeNull();
    expect(await storedSize()).toBe(await truth());

    // E (-> 2500) and F (-> 3500): both events claim before either commits.
    const eventE = new Date();
    await tick();
    const eventF = new Date();
    await tick();
    expect(await s3Event(id, eventE, 2500)).toBe(-500);
    expect(await s3Event(id, eventF, 3500)).toBe(1000);
    await fabFilesService.commitContentRewrite({ fabFileId: id, newSize: 2500 }, rewriteDb);
    await fabFilesService.commitContentRewrite({ fabFileId: id, newSize: 3500 }, rewriteDb);
    expect((await FabFile.findById(id).lean())?.fileSize).toBe(3500);
    expect(await storedSize()).toBe(await truth());

    // C (-> 500) commits; then D (-> 700)'s own event claims before D commits.
    await rewrite(id, 500);
    await rewrite(id, 700, async eventTime => {
      expect(await s3Event(id, eventTime, 700)).toBe(200);
    });
    expect(await storedSize()).toBe(BASELINE_BYTES + 700);
    expect(await storedSize()).toBe(await truth());
  });

  it('changes nothing when an Office repoint loses its race', async () => {
    await seedUser();
    const id = await firstUpload(100);

    const committed = await fabFilesService.commitContentRewrite(
      { fabFileId: id, newSize: 400, filter: { filePath: 'files/stale' } },
      rewriteDb
    );

    expect(committed).toBe(false);
    expect(await storedSize()).toBe(BASELINE_BYTES + 100);
  });
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
    expect(await storedSize()).toBe(BASELINE_BYTES + FILE_BYTES);
  });

  it('leaves the S3 event for the imported upload nothing to charge', async () => {
    await seedUser();
    const uploadedAt = new Date(Date.now() - 1000);
    await importAndCharge('charged');
    const row = await FabFile.findOne({ userId: USER });

    expect(await claimStorageCharge(row?._id, uploadedAt, FILE_BYTES)).toBeNull();
  });

  it('leaves the S3 event for a rewrite of an imported file nothing to charge', async () => {
    await seedUser();
    await importAndCharge('rewritten');
    const row = await FabFile.findOne({ userId: USER });

    const eventTime = await rewrite(String(row?._id), 1234);

    expect(await claimStorageCharge(row?._id, eventTime, 1234)).toBeNull();
    expect(await storedSize()).toBe(BASELINE_BYTES + (await fabFileRepository.sumFileSizeByUserId(USER)));
  });

  it('charges a redelivered S3 event once', async () => {
    const [row] = await FabFile.create([
      { userId: USER, fileName: 'x', mimeType: 'text/plain', fileSize: 5, filePath: 'knowledge/x', type: 'FILE' },
    ]);
    const uploadedAt = new Date();

    expect(await claimStorageCharge(row._id, uploadedAt, 5)).toBe(5);
    expect(await claimStorageCharge(row._id, uploadedAt, 5)).toBeNull();
  });

  it('charges nothing when the transaction rolls back', async () => {
    await seedUser();

    await expect(
      withTransaction(async session => {
        const result = await makeService().importNotebooks(USER, payload('rolled') as never, OPTIONS as never);
        await stampImportedKnowledgeRows(USER, result.importedKnowledgeFilePaths ?? [], session);
        throw new Error('abort');
      })
    ).rejects.toThrow('abort');

    expect(await storedSize()).toBe(BASELINE_BYTES);
    expect(await FabFile.countDocuments({ userId: USER })).toBe(0);
  });

  it("never charges another user's row that shares a path", async () => {
    await seedUser();
    const other = new mongoose.Types.ObjectId().toString();
    await FabFile.create([
      { userId: other, fileName: 'x', mimeType: 'text/plain', fileSize: 5, filePath: 'knowledge/x', type: 'FILE' },
    ]);

    expect(await chargeStampedKnowledgeStorage(USER, ['knowledge/x'], new Date())).toBe(0);
  });
});

describe('chargeUploadedObject', () => {
  const createRow = async () =>
    (
      await FabFile.create([
        { userId: USER, fileName: 'u', mimeType: 'text/plain', fileSize: 1, filePath: 'uploads/u', type: 'FILE' },
      ])
    )[0];

  /** One webhook delivery as the self-host route runs it: load, charge, save in one transaction. */
  const deliver = (fabFileId: unknown, size: number, uploadedAt: Date) =>
    withTransaction(async session => {
      const user = await User.findById(USER_ID).session(session);
      if (user && (await chargeUploadedObject(fabFileId as string, user, size, uploadedAt, session))) {
        await user.save({ session, validateBeforeSave: false });
      }
    });

  it('charges the object size once, even when the event is redelivered', async () => {
    await seedUser();
    const row = await createRow();
    const uploadedAt = new Date();

    await deliver(row._id, 5_000, uploadedAt);
    await deliver(row._id, 5_000, uploadedAt);

    expect(await storedSize()).toBe(BASELINE_BYTES + 5_000);
  });

  it('charges a later write to the same object only its growth', async () => {
    await seedUser();
    const row = await createRow();
    const uploadedAt = new Date();

    await deliver(row._id, 5_000, uploadedAt);
    await deliver(row._id, 8_000, new Date(uploadedAt.getTime() + 1000));

    expect(await storedSize()).toBe(BASELINE_BYTES + 8_000);
    expect((await FabFile.findById(row._id).lean())?.fileSize).toBe(8_000);
  });

  it('never takes the counter below zero', async () => {
    await seedUser();
    const row = await createRow();

    await deliver(row._id, -BASELINE_BYTES * 2, new Date());

    expect(await storedSize()).toBe(0);
  });
});
