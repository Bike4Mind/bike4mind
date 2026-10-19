import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { isStorageCharged, STORAGE_CHARGE_STAMP_CUTOFF, STORAGE_CHARGED_FILTER } from '@bike4mind/common';
import {
  FabFile,
  Organization,
  fabFileChunkRepository,
  fabFileRepository,
  Session,
  sessionRepository,
  User,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
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
    Organization.collection.deleteMany({}),
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

/**
 * One S3 event as objectCreated charges it: mark the row complete, then claim judged by the status
 * from before that flip. Returns what it charged, or null when its claim lost.
 */
const s3Event = async (fabFileId: unknown, eventTime: Date, size: number) => {
  const before = await FabFile.collection.findOne({ _id: new mongoose.Types.ObjectId(String(fabFileId)) });
  await FabFile.collection.updateOne({ _id: before?._id }, { $set: { status: 'complete' } });
  const charged = (await claimStorageCharge(fabFileId as string, eventTime, size, before?.status))?.delta ?? null;
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
 * An unstamped file created pre-cutoff: `complete` (the S3 handler charged it), or with no status at
 * all, which the charge rule reads as never charged, so the counter does not hold it.
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
  if (!noStatus) await userRepository.incrementCurrentStorage(USER, fileSize);
  return String(row._id);
};

describe('STORAGE_CHARGED_FILTER', () => {
  it('selects exactly the rows isStorageCharged counts', async () => {
    const before = new Date(STORAGE_CHARGE_STAMP_CUTOFF.getTime() - 1000);
    const after = new Date(STORAGE_CHARGE_STAMP_CUTOFF.getTime() + 1000);
    const shapes: Record<string, unknown>[] = [
      { storageChargedAt: after, status: 'pending', createdAt: after },
      { status: 'pending', createdAt: before },
      { status: 'complete', createdAt: before },
      { status: 'complete', createdAt: after },
      { status: null, createdAt: before },
      { createdAt: before },
      { createdAt: after },
      { status: 'complete' },
    ];
    const ids = shapes.map(() => new mongoose.Types.ObjectId());
    await FabFile.collection.insertMany(shapes.map((shape, i) => ({ _id: ids[i], userId: USER, ...shape })));

    const rows = await FabFile.collection.find({ _id: { $in: ids } }).toArray();
    const matched = await FabFile.collection.find({ _id: { $in: ids }, ...STORAGE_CHARGED_FILTER }).toArray();
    expect(matched.map(r => String(r._id)).sort()).toEqual(
      rows
        .filter(r => isStorageCharged(r))
        .map(r => String(r._id))
        .sort()
    );
    expect(matched).toHaveLength(2);
  });
});

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

  // Every row shape the charge rule distinguishes, in both event orders, for growth, no change and
  // shrink, with the bytes the counter already holds for it.
  const shapes = {
    stamped: { create: () => firstUpload(5000), charged: 5000 },
    'legacy complete': { create: () => legacyFile(5000), charged: 5000 },
    'legacy no-status': { create: () => legacyFile(5000, { noStatus: true }), charged: 0 },
  };
  it.each(
    (Object.keys(shapes) as (keyof typeof shapes)[]).flatMap(shape =>
      (['commit first', 'event first'] as const).flatMap(order =>
        [5100, 5000, 4000].map(newSize => [shape, order, newSize] as const)
      )
    )
  )('charges a rewrite of a %s file only the delta (%s, to %i bytes)', async (shape, order, newSize) => {
    await seedUser();
    const id = await shapes[shape].create();
    expect(await storedSize()).toBe(await truth());

    if (order === 'event first') {
      await rewrite(id, newSize, async eventTime => {
        expect(await s3Event(id, eventTime, newSize)).toBe(newSize - shapes[shape].charged);
      });
    } else {
      const eventTime = await rewrite(id, newSize);
      expect(await s3Event(id, eventTime, newSize)).toBeNull();
    }

    expect(await storedSize()).toBe(BASELINE_BYTES + newSize);
    expect(await storedSize()).toBe(await truth());
  });

  it('never refuses a shrink of a legacy unstamped file near the quota', async () => {
    await seedUser();
    const id = await legacyFile(850_000);
    const row = await FabFile.findById(id);
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

    expect(await claimStorageCharge(row?._id, uploadedAt, FILE_BYTES, row?.status)).toBeNull();
  });

  it('leaves the S3 event for a rewrite of an imported file nothing to charge', async () => {
    await seedUser();
    await importAndCharge('rewritten');
    const row = await FabFile.findOne({ userId: USER });

    const eventTime = await rewrite(String(row?._id), 1234);

    expect(await claimStorageCharge(row?._id, eventTime, 1234, row?.status)).toBeNull();
    expect(await storedSize()).toBe(BASELINE_BYTES + (await fabFileRepository.sumFileSizeByUserId(USER)));
  });

  it('charges a redelivered S3 event once', async () => {
    const [row] = await FabFile.create([
      { userId: USER, fileName: 'x', mimeType: 'text/plain', fileSize: 5, filePath: 'knowledge/x', type: 'FILE' },
    ]);
    const uploadedAt = new Date();

    expect((await claimStorageCharge(row._id, uploadedAt, 5, 'pending'))?.delta).toBe(5);
    expect(await claimStorageCharge(row._id, uploadedAt, 5, 'pending')).toBeNull();
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

// A presigned upload's row exists `pending` with its claimed size before ObjectCreated charges it;
// deleting it in that window used to refund bytes never charged, leaving the counter below recalc.
describe('delete before the ObjectCreated event', () => {
  const deleteAndRefund = (id: string) =>
    fabFilesService.deleteFabFile(USER, { id }, {
      db: {
        fabFiles: fabFileRepository,
        users: userRepository,
        sessions: sessionRepository,
        fabFileChunks: fabFileChunkRepository,
      },
      storage: { delete: async () => {} },
      onDeleteComplete: async (_fabFile, size) => {
        if (size > 0) await userRepository.incrementCurrentStorage(USER, -size);
      },
    } as never);

  it('keeps the counter equal to the recalc truth', async () => {
    const charged = { fileName: 'c', mimeType: 'text/plain', fileSize: 5, filePath: 'knowledge/c', type: 'FILE' };
    const [stamped, pending] = await FabFile.create([
      { ...charged, userId: USER, status: 'complete', storageChargedAt: new Date() },
      { ...charged, userId: USER, fileName: 'p', filePath: 'knowledge/p', fileSize: 400, status: 'pending' },
    ]);
    await User.collection.insertOne({ _id: USER_ID, storageLimit: STORAGE_LIMIT_MB, currentStorageSize: 5 });
    expect(await fabFileRepository.sumFileSizeByUserId(USER)).toBe(5);

    await deleteAndRefund(pending._id.toString());
    expect(await storedSize()).toBe(5);
    expect(await fabFileRepository.sumFileSizeByUserId(USER)).toBe(5);
    // The event arriving after the delete must not charge the tombstone, since nothing refunded it.
    expect(await claimStorageCharge(pending._id, new Date(), 400, 'pending')).toBeNull();
    expect(await storedSize()).toBe(5);

    await deleteAndRefund(stamped._id.toString());
    expect(await storedSize()).toBe(0);
    expect(await fabFileRepository.sumFileSizeByUserId(USER)).toBe(0);
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
      if (user && (await chargeUploadedObject(fabFileId as string, user, size, uploadedAt, 'pending', session))) {
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

  describe('an org-stamped row', () => {
    const ORG_ID = new mongoose.Types.ObjectId();
    const ORG_BASELINE_BYTES = 50_000;
    const orgStoredSize = async () => (await Organization.collection.findOne({ _id: ORG_ID }))?.currentStorageSize;

    const createOrgRow = async () =>
      (
        await FabFile.create([
          {
            userId: USER,
            organizationId: ORG_ID.toString(),
            fileName: 'o',
            mimeType: 'text/plain',
            fileSize: 1,
            filePath: 'uploads/o',
            type: 'FILE',
          },
        ])
      )[0];

    it("charges the org's counter and leaves the uploader's untouched", async () => {
      await seedUser();
      await Organization.collection.insertOne({ _id: ORG_ID, currentStorageSize: ORG_BASELINE_BYTES });
      const row = await createOrgRow();

      await deliver(row._id, 5_000, new Date());

      expect(await orgStoredSize()).toBe(ORG_BASELINE_BYTES + 5_000);
      expect(await storedSize()).toBe(BASELINE_BYTES);
    });

    it('charges a redelivered event to the org once', async () => {
      await seedUser();
      await Organization.collection.insertOne({ _id: ORG_ID, currentStorageSize: ORG_BASELINE_BYTES });
      const row = await createOrgRow();
      const uploadedAt = new Date();

      await deliver(row._id, 5_000, uploadedAt);
      await deliver(row._id, 5_000, uploadedAt);

      expect(await orgStoredSize()).toBe(ORG_BASELINE_BYTES + 5_000);
      expect(await storedSize()).toBe(BASELINE_BYTES);
    });
  });
});
