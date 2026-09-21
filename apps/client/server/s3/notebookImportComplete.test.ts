import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Covers the duplicate-event guard in `dispatch`, which is the import worker's idempotency
 * mechanism: S3 can redeliver an event after the first invocation already deleted the object, and
 * the redelivery must be skipped silently. If it stops being skipped, the record falls through to
 * the failure path and the user gets an "Import Failed" inbox message for an import that worked.
 *
 * The guard reads `.name` off the rejection rather than gating on `instanceof Error`, so a
 * plain-object rejection - which is how this repo's other suites mock S3 failures - is still
 * recognised. The plain-object case below is what distinguishes the two forms.
 */

const h = vi.hoisted(() => ({
  getMetadata: vi.fn(),
  getContentAsBuffer: vi.fn(),
  findByS3Key: vi.fn(),
  createInboxMessage: vi.fn(),
  jobCreate: vi.fn(),
  jobUpdate: vi.fn(),
  hasActiveImport: vi.fn(),
  deleteFile: vi.fn(),
  importNotebooks: vi.fn(),
  getImportedKnowledgeFilePaths: vi.fn(),
}));

vi.mock('@server/s3/utils', () => ({ withContext: (fn: unknown) => fn }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    getMetadata = h.getMetadata;
    getContentAsBuffer = h.getContentAsBuffer;
    delete = vi.fn().mockResolvedValue(undefined);
    download = vi.fn();
  },
}));
vi.mock('sst', () => ({ Resource: { historyImportBucket: { name: 'import-bucket' } } }));
vi.mock('@bike4mind/database', () => ({
  inboxRepository: { createInboxMessage: h.createInboxMessage },
  importHistoryJobRepository: {
    findByS3Key: h.findByS3Key,
    create: h.jobCreate,
    update: h.jobUpdate,
    hasActiveImport: h.hasActiveImport,
  },
  imageModerationIncidentRepository: {},
  adminSettingsRepository: {},
  sessionRepository: {},
  questRepository: {},
  Quest: {},
  FabFile: {},
  Artifact: {},
  Agent: {},
  Tool: {},
  User: {},
  withTransaction: (fn: (session: unknown) => Promise<unknown>) => fn(undefined),
}));
vi.mock('@bike4mind/services', () => ({
  notebookImportService: {
    // A throwaway stand-in for the real service: the cleanup under test reads only the paths this
    // reports and the rejection that abandoned the transaction.
    NotebookImportService: class {
      importNotebooks = h.importNotebooks;
      getImportedKnowledgeFilePaths = h.getImportedKnowledgeFilePaths;
    },
  },
}));
vi.mock('@bike4mind/services/llm', () => ({
  moderateImageOrThrow: vi.fn(),
}));
vi.mock('@bike4mind/common', () => ({ InboxType: { COMMON: 'common' }, isImageServeable: () => true }));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
// Post-commit knowledge-file moderation deps: mocked like every other heavy import so this
// dispatch-idempotency test stays isolated (the moderation path is not exercised here).
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: vi.fn(), getSettingsValue: vi.fn() }));
vi.mock('@bike4mind/utils/imageModeration', () => ({ RekognitionImageModerationService: class {} }));
vi.mock('@server/s3/moderateUploadedFile', () => ({ moderateUploadedFile: vi.fn() }));
vi.mock('@server/s3/moderateImportedKnowledgeFiles', () => ({ moderateImportedKnowledgeFiles: vi.fn() }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ delete: h.deleteFile, upload: vi.fn(), getContentAsBuffer: vi.fn() }),
}));
vi.mock('@server/utils/importHistoryProgress', () => ({
  updateImportProgress: vi.fn(),
  markImportComplete: vi.fn(),
  markImportFailed: vi.fn(),
}));
vi.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { dispatch, discardUploadedKnowledgeFiles } from './notebookImportComplete';
import { moderateImportedKnowledgeFiles } from '@server/s3/moderateImportedKnowledgeFiles';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const event = {
  Records: [
    {
      s3: {
        bucket: { name: 'import-bucket' },
        object: { key: 'notebooks/user-1/2026-08-10T00-00-00.json' },
      },
    },
  ],
};

const run = () => (dispatch as unknown as (e: unknown, c: unknown, l: unknown) => Promise<void>)(event, {}, logger);

beforeEach(() => {
  vi.clearAllMocks();
  h.findByS3Key.mockResolvedValue(null);
  // The handler chains `.catch()` onto this, so it has to be a promise.
  h.createInboxMessage.mockResolvedValue(undefined);
  // Baseline for the rollback suite below; each test overrides only what it needs.
  h.hasActiveImport.mockResolvedValue(false);
  h.jobUpdate.mockResolvedValue(undefined);
  h.deleteFile.mockResolvedValue(undefined);
  h.getImportedKnowledgeFilePaths.mockReturnValue([]);
});

describe('notebook import duplicate-event guard', () => {
  it('skips a redelivered event when the object is already gone (Error with name NoSuchKey)', async () => {
    h.getMetadata.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));

    await run();

    // Skipped means it never reached the job lookup, so nothing downstream ran.
    expect(h.findByS3Key).not.toHaveBeenCalled();
    expect(h.createInboxMessage).not.toHaveBeenCalled();
  });

  it('skips a redelivered event for NotFound, which is what HeadObject rejects with', async () => {
    h.getMetadata.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NotFound' }));

    await run();

    expect(h.findByS3Key).not.toHaveBeenCalled();
    expect(h.createInboxMessage).not.toHaveBeenCalled();
  });

  it('skips a plain-object rejection carrying the name, with no Error prototype', async () => {
    // The distinguishing case: `instanceof Error` would be false here, the branch would be
    // missed, and a duplicate event would be reported to the user as a failed import.
    h.getMetadata.mockRejectedValue({ name: 'NoSuchKey' });

    await run();

    expect(h.findByS3Key).not.toHaveBeenCalled();
    expect(h.createInboxMessage).not.toHaveBeenCalled();
  });

  it('does not swallow an unrelated failure', async () => {
    h.getMetadata.mockRejectedValue(new Error('boom'));

    await run();

    // Not skipped: the guard must stay narrow, so this reaches the failure path and the user
    // is told. Pins that the not-found branch did not widen into catching everything.
    expect(h.createInboxMessage).toHaveBeenCalled();
  });
});

/**
 * Uploads cannot join the import's transaction, so a rollback leaves the objects behind unless the
 * handler removes them. Only the callback's own catch sees the paths the failed attempt reported:
 * `withTransaction` re-runs the callback on a transient error against a fresh service, so cleanup
 * after it rejects would miss every earlier attempt's objects.
 *
 * The committed path is the other half of the same coin. Those objects DO have rows pointing at
 * them, and `result.importedKnowledgeFilePaths` is what the post-commit moderation pass scans, so
 * the cleanup has to leave that list alone rather than sharing state with it.
 */
describe('notebook import: uploaded knowledge objects track the transaction outcome', () => {
  beforeEach(() => {
    h.getMetadata.mockResolvedValue({ size: 10 });
    // Both the data and the options key are read through this one mock; the payload is irrelevant
    // to the rollback under test, only that the callback gets far enough to run the service.
    h.getContentAsBuffer.mockResolvedValue(Buffer.from(JSON.stringify({ notebooks: [] })));
    h.jobCreate.mockResolvedValue({ id: 'job-1' });
  });

  it('deletes every uploaded knowledge path when the import is rolled back', async () => {
    h.getImportedKnowledgeFilePaths.mockReturnValue(['knowledge/user-1/a', 'knowledge/user-1/b']);
    h.importNotebooks.mockRejectedValue(new Error('write aborted'));

    await run();

    // The transaction rolled both rows back; the objects have no row left to point at them.
    expect(h.deleteFile).toHaveBeenCalledTimes(2);
    expect(h.deleteFile).toHaveBeenCalledWith('knowledge/user-1/a');
    expect(h.deleteFile).toHaveBeenCalledWith('knowledge/user-1/b');
  });

  it('attempts every path even when one delete fails, and never rejects', async () => {
    h.deleteFile.mockRejectedValueOnce(new Error('delete failed'));

    // Resolves rather than rejecting: a cleanup failure must not replace the error being unwound.
    await expect(
      discardUploadedKnowledgeFiles(['knowledge/user-1/a', 'knowledge/user-1/b'], logger)
    ).resolves.toBeUndefined();

    // The second path is still attempted after the first delete threw.
    expect(h.deleteFile).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete uploaded knowledge file'),
      expect.objectContaining({ path: 'knowledge/user-1/a' })
    );
  });

  it('deletes nothing, and hands the paths to the moderation pass, when the import commits', async () => {
    h.importNotebooks.mockResolvedValue({
      importedNotebooks: 1,
      importedMessages: 0,
      skippedNotebooks: 0,
      importedKnowledgeFilePaths: ['knowledge/user-1/a'],
    });

    await run();

    // These rows committed, so their objects are referenced and must survive - the compensation
    // exists only for the rejection path, and must not reach into the committed one.
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(moderateImportedKnowledgeFiles).toHaveBeenCalledWith(
      expect.objectContaining({ filePaths: ['knowledge/user-1/a'] })
    );
  });
});
