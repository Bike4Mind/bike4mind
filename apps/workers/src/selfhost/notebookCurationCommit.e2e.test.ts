import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  User,
  Session,
  Quest,
  FabFile,
  NotebookCurationJob,
  CreditTransaction,
  userRepository,
  sessionRepository,
  questRepository,
  fabFileRepository,
  adminSettingsRepository,
} from '@bike4mind/database';
import { CurationType } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { NotebookCurationService } from '../../../../b4m-core/services/src/notebookCurationService';
import { createNotebookCommit } from '@workers/queueHandlers/notebookCurationCommit';
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let mongo: Awaited<ReturnType<typeof createMongoReplSet>>;
let userId: string;
let sessionId: string;
const objects = new Map<string, string>();
const options = {
  curationType: CurationType.TRANSCRIPT,
  exportFormat: 'markdown' as const,
  includeCode: true,
  includeDiagrams: true,
  includeDataViz: true,
  includeQuestMaster: true,
  includeResearch: true,
  includeImages: true,
};
const logger = new Logger();
function service(job = 'job') {
  return new NotebookCurationService({
    userRepository,
    sessionRepository,
    chatHistoryRepository: questRepository,
    fabFileRepository,
    adminSettingsRepository,
    logger,
    objectKeyPrefix: `curated-notebooks/jobs/${job}`,
    fileStorageService: {
      upload: async (key, content) => {
        objects.set(key, content.toString());
        return key;
      },
      generateSignedUrl: async key => `http://storage.invalid/${key}`,
    },
    commitCuration: createNotebookCommit(
      { curationJobId: job, sessionId, userId },
      async key => objects.delete(key),
      message => logger.warn(message)
    ),
  });
}
beforeAll(async () => {
  mongo = await createMongoReplSet();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([NotebookCurationJob.createIndexes(), FabFile.createIndexes(), CreditTransaction.createIndexes()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  for (const model of [User, Session, Quest, FabFile, NotebookCurationJob, CreditTransaction])
    await model.collection.deleteMany({});
  objects.clear();
  userId = String(new mongoose.Types.ObjectId());
  sessionId = String(new mongoose.Types.ObjectId());
  await User.collection.insertOne({
    _id: new mongoose.Types.ObjectId(userId),
    currentCredits: 1000,
    storageLimit: 100000,
    currentStorageSize: 0,
  });
  await Session.collection.insertOne({
    _id: new mongoose.Types.ObjectId(sessionId),
    userId,
    name: 'Transcript fixture',
  });
  await Quest.collection.insertOne({
    _id: new mongoose.Types.ObjectId(),
    userId,
    sessionId,
    prompt: 'What survives?',
    reply: 'A readable transcript.',
    timestamp: new Date(),
  });
});
afterEach(() => vi.restoreAllMocks());
// Curation writes no credit rows itself (the executive-summary LLM calls are billed per call by the
// worker's meter), so a transcript curation leaves the balance untouched.
it('rolls back file and cache on a failed session write, then retries exactly once', async () => {
  const failure = vi.spyOn(sessionRepository, 'update').mockRejectedValueOnce(new Error('session write unavailable'));
  expect((await service().curateNotebook(sessionId, userId, options)).success).toBe(false);
  expect(await FabFile.countDocuments({})).toBe(0);
  expect(await CreditTransaction.countDocuments({})).toBe(0);
  expect(await NotebookCurationJob.countDocuments({})).toBe(0);
  expect((await Session.findById(sessionId).lean())?.curationContentHash).toBeFalsy();
  failure.mockRestore();
  const result = await service().curateNotebook(sessionId, userId, options);
  expect(result.success).toBe(true);
  expect((await User.findById(userId).lean())?.currentCredits).toBe(1000);
  const file = await FabFile.findById(result.curatedFileId).lean();
  expect(objects.get(file!.filePath!)).toContain('A readable transcript.');
  expect((await Session.findById(sessionId).lean())?.curatedNotebookFileId).toBe(result.curatedFileId);
  expect((await NotebookCurationJob.findOne({ curationJobId: 'job' }).lean())?.result).toMatchObject(result);
  await service().curateNotebook(sessionId, userId, options);
  expect(await FabFile.countDocuments({})).toBe(1);
  expect(await CreditTransaction.countDocuments({})).toBe(0);
  expect((await User.findById(userId).lean())?.currentCredits).toBe(1000);
});
it('returns the committed winner without writing again', async () => {
  const first = await service().curateNotebook(sessionId, userId, options);
  expect(first.success).toBe(true);
  const commit = createNotebookCommit(
    { curationJobId: 'job', sessionId, userId },
    async key => objects.delete(key),
    message => logger.warn(message)
  );
  const write = vi.fn();
  expect(await commit(write)).toMatchObject(first);
  expect(write).not.toHaveBeenCalled();
  expect(await FabFile.countDocuments({})).toBe(1);
});
it('concurrent different artifacts return one durable winner', async () => {
  const results = await Promise.all([
    service().curateNotebook(sessionId, userId, options),
    service().curateNotebook(sessionId, userId, { ...options, exportFormat: 'html' }),
  ]);
  expect(results.map(result => result.success)).toEqual([true, true]);
  expect(results[0].curatedFileId).toBe(results[1].curatedFileId);
  expect(await FabFile.countDocuments({})).toBe(1);
  expect(await CreditTransaction.countDocuments({})).toBe(0);
  const winner = await FabFile.findById(results[0].curatedFileId).lean();
  expect(objects.size).toBe(1);
  expect(objects.get(winner!.filePath!)).toContain('A readable transcript.');
});
it('rejects a receipt belonging to another account or session', async () => {
  expect((await service().curateNotebook(sessionId, userId, options)).success).toBe(true);
  const other = createNotebookCommit(
    { curationJobId: 'job', sessionId, userId: 'other' },
    async key => objects.delete(key),
    message => logger.warn(message)
  );
  const write = vi.fn();
  await expect(other(write)).rejects.toThrow('identity mismatch');
  expect(write).not.toHaveBeenCalled();
});
it('reads the committed receipt after the transaction acknowledgement is lost', async () => {
  const transaction = mongoose.connection.transaction.bind(mongoose.connection);
  vi.spyOn(mongoose.connection, 'transaction').mockImplementationOnce(async (...args) => {
    await transaction(...args);
    throw new Error('commit acknowledgement lost');
  });
  const result = await service().curateNotebook(sessionId, userId, options);
  expect(result.success).toBe(true);
  expect(await NotebookCurationJob.countDocuments({})).toBe(1);
  const file = await FabFile.findById(result.curatedFileId).lean();
  expect(objects.has(file!.filePath!)).toBe(true);
});
