import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  updateOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  findById: vi.fn(),
  userFindById: vi.fn(),
  getSettingsValue: vi.fn(),
  claimFileStatus: vi.fn(),
  incrementCounter: vi.fn(),
  moderateUploadedFile: vi.fn(),
  sendToClient: vi.fn(),
  sendToQueue: vi.fn(),
  recomputeUploaded: vi.fn(),
  finalizeBatchIfComplete: vi.fn(),
  isBatchComplete: vi.fn(),
}));

// withContext just threads a logger; the handler body is the subject.
vi.mock('@server/s3/utils', () => ({
  withContext: (fn: unknown) => fn,
  decodeS3Key: (k: string) => k,
  findWithRetry: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  changeStorageSize: vi.fn(),
  dataLakeBatchRepository: { claimFileStatus: h.claimFileStatus, incrementCounter: h.incrementCounter },
  FabFile: {
    findOne: h.findOne,
    updateOne: h.updateOne,
    findOneAndUpdate: h.findOneAndUpdate,
    findById: h.findById,
  },
  imageModerationIncidentRepository: {},
  User: { findById: h.userFindById },
  withTransaction: (fn: (session: unknown) => Promise<unknown>) => fn(undefined),
}));
vi.mock('@bike4mind/services', () => ({ moderateImageOrThrow: vi.fn() }));
vi.mock('@bike4mind/common', () => ({ isAudioMimeType: () => false }));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: vi.fn(async () => ({})), getSettingsValue: () => true }));
vi.mock('@bike4mind/utils/imageModeration', () => ({ RekognitionImageModerationService: class {} }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ download: vi.fn(), downloadRange: vi.fn() }) }));
vi.mock('@server/s3/moderateUploadedFile', () => ({ moderateUploadedFile: h.moderateUploadedFile }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: h.sendToClient }));
vi.mock('@server/dataLakes/recomputeStatsForUploadedFile', () => ({
  recomputeStatsForUploadedFile: h.recomputeUploaded,
}));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({
  finalizeBatchIfComplete: h.finalizeBatchIfComplete,
  isBatchComplete: h.isBatchComplete,
}));
vi.mock('sst', () => ({
  Resource: { websocket: { managementEndpoint: 'wss://test' }, fabFileChunkQueue: { url: 'http://sqs/chunk' } },
}));

import { func } from './objectCreated';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() };
const event = { Records: [{ s3: { object: { key: 'uploads/report.pdf', size: 10 } } }] };
const run = () => (func as unknown as (e: unknown, c: unknown, l: unknown) => Promise<void>)(event, {}, logger);

const metadata = (over: Record<string, unknown> = {}) => ({
  id: 'ff1',
  _id: 'ff1',
  userId: 'u1',
  mimeType: 'application/pdf',
  tags: [{ name: 'datalake:acme' }],
  save: vi.fn(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.updateOne.mockResolvedValue({ modifiedCount: 1 });
  h.findOneAndUpdate.mockResolvedValue({ id: 'ff1' });
  h.moderateUploadedFile.mockResolvedValue({ moderationStatus: 'clean' });
  h.userFindById.mockReturnValue({ session: () => ({ id: 'u1', currentStorageSize: 1, save: vi.fn() }) });
  h.getSettingsValue.mockResolvedValue(false);
  h.claimFileStatus.mockResolvedValue(true);
  h.incrementCounter.mockResolvedValue({ uploadedFiles: 1 });
});

describe('objectCreated - data lake stats (#1342)', () => {
  it('recomputes the lakes the file joined, now that its bytes have landed', async () => {
    // The lake meta-tag was stamped when the row was created, before any bytes existed. This
    // event is the first point the count is honest - and counting activates a draft lake.
    const file = metadata();
    h.findOne.mockResolvedValue(file);

    await run();

    expect(h.recomputeUploaded).toHaveBeenCalledWith(file, { logger });
  });

  it('still hands a batch file over, leaving the per-batch skip to the helper', async () => {
    // Keeping the rule in one place is what stops the hosted and self-host paths disagreeing.
    const file = metadata({ batchId: 'b1' });
    h.findOne.mockResolvedValue(file);

    await run();

    expect(h.recomputeUploaded).toHaveBeenCalledWith(file, { logger });
  });

  it('accounts a skipped batch file as skippedFiles, not a hang until the reconciler', async () => {
    // autochunk is off (the beforeEach default), so this file never reaches the chunk/vectorize
    // handlers - without this, the batch's completion threshold would never close on its own.
    const file = metadata({ batchId: 'b1' });
    h.findOne.mockResolvedValue(file);
    h.incrementCounter.mockResolvedValue({ id: 'b1', skippedFiles: 1, failedFiles: 0 });
    h.isBatchComplete.mockReturnValue(true);

    await run();

    expect(h.claimFileStatus).toHaveBeenCalledWith('b1', 'ff1', ['uploaded', 'pending'], 'skipped');
    expect(h.incrementCounter).toHaveBeenCalledWith('b1', 'skippedFiles');
    expect(h.finalizeBatchIfComplete).toHaveBeenCalledWith({ id: 'b1', skippedFiles: 1, failedFiles: 0 }, logger);
    // The uploadedFiles/vectorizedFiles branches both send their own counter in the progress
    // event; skippedFiles must too, or a client reading it sees a stale value until reload.
    expect(h.sendToClient).toHaveBeenCalledWith(
      'u1',
      'wss://test',
      expect.objectContaining({ action: 'data_lake_batch_progress', batchId: 'b1', skippedFiles: 1 })
    );
  });

  it('does not double-count a batch file that is actually chunked', async () => {
    const file = metadata({ batchId: 'b1' });
    h.findOne.mockResolvedValue(file);
    h.getSettingsValue.mockResolvedValue(true); // enableKnowledgeAutoChunk on

    await run();

    expect(h.sendToQueue).toHaveBeenCalled();
    expect(h.finalizeBatchIfComplete).not.toHaveBeenCalled();
  });

  it('does not recompute when no FabFile matches the uploaded key', async () => {
    h.findOne.mockResolvedValue(null);

    await run();

    expect(h.recomputeUploaded).not.toHaveBeenCalled();
  });
});

describe('objectCreated - upload status is recorded independently of post-processing', () => {
  let file: ReturnType<typeof metadata> & { status?: string; moderationStatus?: string };

  beforeEach(() => {
    file = metadata({ status: 'pending', moderationStatus: 'pending' });
    h.findOne.mockResolvedValue(file);
    h.findOneAndUpdate.mockResolvedValue({ ...file, moderationStatus: 'scanning' });
  });

  it("marks the file 'complete' even when the owner lookup fails", async () => {
    h.userFindById.mockReturnValue({ session: () => null });

    await run();

    expect(h.updateOne).toHaveBeenCalledWith({ _id: 'ff1' }, { $set: { status: 'complete' } });
  });

  it("marks the file 'complete' before a moderation scan that throws", async () => {
    h.moderateUploadedFile.mockRejectedValue(new Error('Rekognition unavailable'));

    await expect(run()).rejects.toThrow('Rekognition unavailable');

    expect(h.updateOne).toHaveBeenCalledWith({ _id: 'ff1' }, { $set: { status: 'complete' } });
  });

  it('marks the file complete on the happy path and leaves the moderation verdict on the record', async () => {
    await run();

    expect(h.updateOne).toHaveBeenCalledWith({ _id: 'ff1' }, { $set: { status: 'complete' } });
    expect(file.status).toBe('complete');
    expect(file.moderationStatus).toBe('clean');
    expect(file.save).toHaveBeenCalled();
  });

  it('skips the write when a redelivered event finds the file already complete', async () => {
    file.status = 'complete';

    await run();

    expect(h.updateOne).not.toHaveBeenCalled();
  });
});
