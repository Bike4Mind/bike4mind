import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  userFindById: vi.fn(),
  getSettingsValue: vi.fn(),
  claimFileStatus: vi.fn(),
  incrementCounter: vi.fn(),
  moderateUploadedFile: vi.fn(),
  sendToClient: vi.fn(),
  sendToQueue: vi.fn(),
  recomputeUploaded: vi.fn(),
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
  FabFile: { findOne: h.findOne, findOneAndUpdate: h.findOneAndUpdate, findById: vi.fn() },
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

  it('does not recompute when no FabFile matches the uploaded key', async () => {
    h.findOne.mockResolvedValue(null);

    await run();

    expect(h.recomputeUploaded).not.toHaveBeenCalled();
  });
});
