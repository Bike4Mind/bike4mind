import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findByIdAndUserId: vi.fn(),
  deleteFabFile: vi.fn(),
  adjustOwnerStorageInSession: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  fabFileRepository: { findByIdAndUserId: mocks.findByIdAndUserId },
  fabFileChunkRepository: {},
  sessionRepository: {},
  userRepository: {},
  withTransaction: (fn: (session: string) => Promise<unknown>) => fn('txn'),
}));
vi.mock('@bike4mind/services', () => ({ fabFilesService: { deleteFabFile: mocks.deleteFabFile } }));
vi.mock('../s3/storageCharge', () => ({ adjustOwnerStorageInSession: mocks.adjustOwnerStorageInSession }));
vi.mock('../utils/storage/index', () => ({ getFilesStorage: () => ({ storage: true }) }));

import { discardJobInputFiles } from './discardJobInputFiles';

const logger = { warn: vi.fn(), error: vi.fn() };

describe('discardJobInputFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByIdAndUserId.mockImplementation(async (id: string, userId: string) =>
      id.startsWith('own') ? { id, userId } : null
    );
    mocks.deleteFabFile.mockImplementation(
      async (
        userId: string,
        _input: unknown,
        adapters: { onDeleteComplete: (file: unknown, bytes: number) => void }
      ) => {
        await adapters.onDeleteComplete({ userId, organizationId: null }, 2048);
        return { action: 'deleted' };
      }
    );
  });

  it('deletes each of the caller own files once and refunds the owner storage', async () => {
    await discardJobInputFiles('user-1', ['own-mask', 'own-source', 'own-mask'], logger);

    expect(mocks.deleteFabFile).toHaveBeenCalledTimes(2);
    expect(mocks.deleteFabFile).toHaveBeenCalledWith('user-1', { id: 'own-mask' }, expect.anything());
    expect(mocks.deleteFabFile).toHaveBeenCalledWith('user-1', { id: 'own-source' }, expect.anything());
    expect(mocks.adjustOwnerStorageInSession).toHaveBeenCalledTimes(2);
    expect(mocks.adjustOwnerStorageInSession.mock.calls[0][1]).toBe(-2048);
    expect(mocks.adjustOwnerStorageInSession.mock.calls[0][2]).toBe('txn');
  });

  it('never touches a file the caller does not own, which a delete would only unshare', async () => {
    await discardJobInputFiles('user-1', ['shared-file'], logger);
    expect(mocks.deleteFabFile).not.toHaveBeenCalled();
    expect(mocks.adjustOwnerStorageInSession).not.toHaveBeenCalled();
  });

  it('logs a failed delete and goes on with the rest', async () => {
    mocks.deleteFabFile.mockRejectedValueOnce(new Error('storage down'));

    await expect(discardJobInputFiles('user-1', ['own-mask', 'own-source'], logger)).resolves.toBeUndefined();

    expect(mocks.deleteFabFile).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      '[imageJobs] could not delete a discarded input file',
      expect.objectContaining({ fileId: 'own-mask' })
    );
  });

  it('does nothing for an empty list', async () => {
    await discardJobInputFiles('user-1', [], logger);
    expect(mocks.findByIdAndUserId).not.toHaveBeenCalled();
  });
});
