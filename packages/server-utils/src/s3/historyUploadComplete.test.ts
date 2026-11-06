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
  markImportComplete: vi.fn(),
  markImportFailed: vi.fn(),
}));

vi.mock('./utils', () => ({ withContext: (fn: unknown) => fn }));
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
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  InboxType: { COMMON: 'common' },
}));
vi.mock('../utils/importHistoryProgress', () => ({
  updateImportProgress: vi.fn(),
  markImportComplete: h.markImportComplete,
  markImportFailed: h.markImportFailed,
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

describe('historyUploadComplete completion counts', () => {
  it('completes the job with the counts the import reported', async () => {
    // The job doc is written before the import runs, so it still says 0/N when the import
    // finishes. Completion has to use what the service reported, not that stale doc.
    h.jobCreate.mockResolvedValue({ id: 'job-1', totalItems: 0, processedItems: 0 });
    h.importHistory.mockResolvedValue({ processedItems: 1, totalItems: 1 });

    await run();

    const stats = h.markImportComplete.mock.calls[0][2] as { processedItems: number; totalItems: number };
    expect(stats).toEqual({ processedItems: 1, totalItems: 1, skippedItems: 0 });
  });
});

describe('historyUploadComplete failure inbox message', () => {
  const failWith = async (err: unknown) => {
    h.jobCreate.mockResolvedValue({ id: 'job-1' });
    h.findByS3Key.mockResolvedValueOnce(null).mockResolvedValue({ id: 'job-1' });
    h.importHistory.mockRejectedValue(err);
    await run();
    const failed = h.createInboxMessage.mock.calls.find(
      ([msg]) => (msg as { title: string }).title === 'LLM history import Failed'
    );
    return (failed?.[0] as { message: string }).message;
  };

  it('names the reason and asks for a new export when the file is not a valid export', async () => {
    const message = await failWith(new Error('conversations.json not found in archive'));

    expect(message).toBe(
      "Your ChatGPT import failed: This file doesn't look like a ChatGPT export (no conversations.json). " +
        'Export your history again and upload the new file.'
    );
    expect(message).not.toContain('try again later');
  });

  it('keeps the generic retry advice for an unrecognised error without echoing it', async () => {
    const message = await failWith(new Error('ECONNRESET reading /tmp/import-user-1/history.zip'));

    expect(message).toContain('Something went wrong on our side');
    expect(message).toContain('Please try again later and/or contact support.');
    expect(message).not.toContain('/tmp');
  });

  it('falls back to the generic reason for a non-Error throw', async () => {
    const message = await failWith('string thrown');

    expect(message).toContain('Please try again later and/or contact support.');
  });

  it('still stores the raw error message on the job', async () => {
    await failWith(new Error('conversations.json not found in archive'));

    expect(h.markImportFailed).toHaveBeenCalledWith(
      'job-1',
      'user-1',
      expect.objectContaining({ message: 'conversations.json not found in archive' })
    );
  });
});
