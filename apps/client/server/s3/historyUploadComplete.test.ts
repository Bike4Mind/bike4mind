import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Covers the abandoned-upload cleanup on the "user already has an active import" bail: hosted
 * relies on an S3 lifecycle rule to reap that object, but self-host has no equivalent for the
 * history-import bucket, so the handler must delete it itself. A failed delete must not turn
 * into a failed webhook - no job was ever created on this path, so there is nothing to mark
 * failed either.
 */

const h = vi.hoisted(() => ({
  getMetadata: vi.fn(),
  deleteMock: vi.fn(),
  findByS3Key: vi.fn(),
  hasActiveImport: vi.fn(),
  jobCreate: vi.fn(),
  createInboxMessage: vi.fn(),
  importHistory: vi.fn(),
}));

vi.mock('@server/s3/utils', () => ({ withContext: (fn: unknown) => fn }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    getMetadata = h.getMetadata;
    delete = h.deleteMock;
  },
}));
vi.mock('sst', () => ({ Resource: { historyImportBucket: { name: 'history-bucket' } } }));
vi.mock('@bike4mind/database', () => ({
  inboxRepository: { createInboxMessage: h.createInboxMessage },
  importHistoryJobRepository: {
    findByS3Key: h.findByS3Key,
    hasActiveImport: h.hasActiveImport,
    create: h.jobCreate,
    update: vi.fn(),
  },
  sessionRepository: {},
  Quest: { bulkWrite: vi.fn() },
  User: { findById: vi.fn() },
  withTransaction: (fn: (session: unknown) => Promise<unknown>) => fn(undefined),
}));
vi.mock('@bike4mind/services', () => ({
  importHistoryService: {
    ImportSource: { OPENAI: 'OpenAI', CLAUDE: 'Claude' },
    importHistory: h.importHistory,
  },
}));
vi.mock('@bike4mind/common', () => ({ InboxType: { COMMON: 'common' } }));
vi.mock('@server/utils/importHistoryProgress', () => ({
  updateImportProgress: vi.fn(),
  markImportComplete: vi.fn(),
  markImportFailed: vi.fn(),
}));

import { dispatch } from './historyUploadComplete';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const event = {
  Records: [
    {
      s3: {
        bucket: { name: 'history-bucket' },
        object: { key: 'user-1/OpenAI/1700000000000.zip' },
      },
    },
  ],
};

const run = () => (dispatch as unknown as (e: unknown, c: unknown, l: unknown) => Promise<void>)(event, {}, logger);

beforeEach(() => {
  vi.clearAllMocks();
  h.getMetadata.mockResolvedValue({ size: 1234 });
  h.findByS3Key.mockResolvedValue(null);
  h.hasActiveImport.mockResolvedValue(false);
  h.createInboxMessage.mockResolvedValue(undefined);
  h.deleteMock.mockResolvedValue(undefined);
});

describe('historyUploadComplete abandoned-import cleanup', () => {
  it('deletes the uploaded object when the user already has an active import', async () => {
    h.hasActiveImport.mockResolvedValue(true);

    await run();

    expect(h.deleteMock).toHaveBeenCalledWith('user-1/OpenAI/1700000000000.zip');
    expect(h.jobCreate).not.toHaveBeenCalled();
    expect(h.createInboxMessage).toHaveBeenCalledWith(expect.objectContaining({ title: 'Import Already in Progress' }));
  });

  it('does not fail the webhook when the cleanup delete itself fails', async () => {
    h.hasActiveImport.mockResolvedValue(true);
    h.deleteMock.mockRejectedValue(new Error('minio down'));

    await expect(run()).resolves.toBeUndefined();

    expect(h.createInboxMessage).toHaveBeenCalledWith(expect.objectContaining({ title: 'Import Already in Progress' }));
    // No job exists on this path, so a cleanup failure must not be reported as a failed import.
    expect(h.createInboxMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'LLM history import Failed' })
    );
  });
});
