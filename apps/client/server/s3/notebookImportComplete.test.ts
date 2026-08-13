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
  findByS3Key: vi.fn(),
  createInboxMessage: vi.fn(),
  jobCreate: vi.fn(),
}));

vi.mock('@server/s3/utils', () => ({ withContext: (fn: unknown) => fn }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    getMetadata = h.getMetadata;
    delete = vi.fn();
    download = vi.fn();
  },
}));
vi.mock('sst', () => ({ Resource: { historyImportBucket: { name: 'import-bucket' } } }));
vi.mock('@bike4mind/database', () => ({
  inboxRepository: { createInboxMessage: h.createInboxMessage },
  importHistoryJobRepository: { findByS3Key: h.findByS3Key, create: h.jobCreate },
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
vi.mock('@bike4mind/services', () => ({ notebookImportService: { NotebookImportService: class {} } }));
vi.mock('@bike4mind/common', () => ({ InboxType: { COMMON: 'common' }, isImageServeable: () => true }));
vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({}) }));
vi.mock('@server/utils/importHistoryProgress', () => ({
  updateImportProgress: vi.fn(),
  markImportComplete: vi.fn(),
  markImportFailed: vi.fn(),
}));
vi.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { dispatch } from './notebookImportComplete';

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
