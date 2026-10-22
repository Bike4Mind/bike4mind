import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileEvents } from '@bike4mind/common';

const {
  mockFindById,
  mockDeleteFabFile,
  mockFindUser,
  mockChangeStorageSize,
  mockLogEvent,
  mockRecompute,
  mockIncrementCurrentStorage,
  mockCleanUp,
  txn,
} = vi.hoisted(() => ({
  mockCleanUp: vi.fn(),
  // Whether the fake transaction's callback is running, so a test can tell in-txn from after-commit.
  txn: { open: false, cleanupRanInside: [] as boolean[] },
  mockFindById: vi.fn(),
  mockDeleteFabFile: vi.fn(),
  mockFindUser: vi.fn(),
  mockChangeStorageSize: vi.fn(),
  mockLogEvent: vi.fn(),
  mockRecompute: vi.fn(),
  mockIncrementCurrentStorage: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  memoryLedgerRepository: { markSourceShredded: vi.fn().mockResolvedValue(0) },
  organizationRepository: { incrementCurrentStorage: mockIncrementCurrentStorage },
  changeStorageSize: mockChangeStorageSize,
  dataLakeRepository: {},
  fabFileChunkRepository: {},
  fabFileRepository: { findById: mockFindById },
  fileTagRepository: { touchLastActivityBy: vi.fn() },
  sessionRepository: {},
  projectRepository: {},
  userRepository: {},
  withTransaction: async (fn: (session: unknown) => unknown) => {
    txn.open = true;
    try {
      return await fn('session');
    } finally {
      txn.open = false;
    }
  },
  User: { findById: (id: string) => ({ session: () => mockFindUser(id) }) },
}));
vi.mock('@bike4mind/services', () => ({
  fabFilesService: {
    deleteFabFile: mockDeleteFabFile,
    cleanUpDeletedFileReferences: (...args: unknown[]) => {
      txn.cleanupRanInside.push(txn.open);
      return mockCleanUp(...args);
    },
  },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: () => false }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: mockLogEvent }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: vi.fn(),
  getGeneratedImageStorage: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/dataLakes/recomputeStatsForLakeTags', () => ({
  recomputeStatsForLakeTags: mockRecompute,
}));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({ lakeConfigAuditPrincipal: () => undefined }));
vi.mock('@bike4mind/server-utils/dataLakes/lakeMembershipAuditDb', () => ({ lakeMembershipAuditDb: {} }));

import { deleteFileForUser } from './deleteFileForUser';

const FILE_ID = '507f1f77bcf86cd799439011';
const logger = { error: vi.fn() };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an Express Request carries far more than this helper reads
const req = { user: { id: 'u1' }, logger, ability: 'ability' } as any;

/** Resolves deleteFabFile with `action`, reporting `size` freed bytes through onDeleteComplete. */
function deleteResolves(action: string, size = 0, fabFile: unknown = { userId: 'u1' }, references?: unknown) {
  mockDeleteFabFile.mockImplementation(async (_userId, _params, adapters) => {
    if (size) await adapters.onDeleteComplete(fabFile, size);
    return { action, fabFile, references };
  });
}

const REFERENCES = { fileIds: [FILE_ID], systemFileUserIds: ['u1'], projectUserIds: ['u1'] };

beforeEach(() => {
  vi.clearAllMocks();
  txn.cleanupRanInside.length = 0;
  mockFindById.mockResolvedValue({ userId: 'u1', tags: [] });
  mockFindUser.mockResolvedValue({ save: vi.fn() });
});

describe('deleteFileForUser', () => {
  it('unlinks the returned references after the transaction commits, not inside it', async () => {
    deleteResolves('deleted', 0, { userId: 'u1' }, REFERENCES);

    expect(await deleteFileForUser(req, FILE_ID)).toBe('deleted');

    expect(mockCleanUp).toHaveBeenCalledTimes(1);
    expect(mockCleanUp.mock.calls[0][0]).toEqual(REFERENCES);
    expect(txn.cleanupRanInside).toEqual([false]);
  });

  it('unlinks nothing when the transaction rolls back', async () => {
    deleteResolves('deleted', 0, { userId: 'u1' }, REFERENCES);
    mockLogEvent.mockRejectedValueOnce(new Error('log failed'));

    await expect(deleteFileForUser(req, FILE_ID)).rejects.toThrow('log failed');

    expect(mockCleanUp).not.toHaveBeenCalled();
  });

  it('deducts the freed bytes from the owner and logs DELETE_FILE', async () => {
    const user = { save: vi.fn() };
    mockFindUser.mockResolvedValue(user);
    deleteResolves('deleted', 500);

    expect(await deleteFileForUser(req, FILE_ID)).toBe('deleted');

    expect(mockChangeStorageSize).toHaveBeenCalledWith(user, -500);
    expect(user.save).toHaveBeenCalledWith({ session: 'session' });
    expect(mockLogEvent).toHaveBeenCalledWith(
      { userId: 'u1', type: FileEvents.DELETE_FILE, metadata: { fileId: FILE_ID } },
      { ability: 'ability', session: 'session' }
    );
  });

  it('refunds the org counter, not the deleting user, for an org-stamped file', async () => {
    deleteResolves('deleted', 500, { userId: 'uploader', organizationId: 'org1' });

    expect(await deleteFileForUser(req, FILE_ID)).toBe('deleted');

    expect(mockIncrementCurrentStorage).toHaveBeenCalledWith('org1', -500, 'session');
    expect(mockFindUser).not.toHaveBeenCalled();
    expect(mockChangeStorageSize).not.toHaveBeenCalled();
  });

  it('refunds the uploader, not the deleting admin, for a personal file', async () => {
    const uploader = { save: vi.fn() };
    mockFindUser.mockResolvedValue(uploader);
    deleteResolves('deleted', 500, { userId: 'uploader' });

    await deleteFileForUser(req, FILE_ID);

    expect(mockFindUser).toHaveBeenCalledWith('uploader');
    expect(mockChangeStorageSize).toHaveBeenCalledWith(uploader, -500);
    expect(mockIncrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('still reports the delete when the storage deduction fails', async () => {
    mockChangeStorageSize.mockRejectedValue(new Error('db down'));
    deleteResolves('deleted', 500);

    expect(await deleteFileForUser(req, FILE_ID)).toBe('deleted');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('storage size'),
      expect.objectContaining({ error: 'db down', sizeToDeduct: 500 })
    );
  });

  it('logs UNSHARE_FILE with the owner for a sharee, and deducts nothing', async () => {
    // Lake-tagged, so the no-recompute assertion below would fail if a sharee's unshare moved stats.
    mockFindById.mockResolvedValue({ userId: 'owner', tags: [{ name: 'datalake:orga:acme' }] });
    deleteResolves('unshared', 0, { userId: 'owner' });

    expect(await deleteFileForUser(req, FILE_ID)).toBe('unshared');

    expect(mockChangeStorageSize).not.toHaveBeenCalled();
    expect(mockRecompute).not.toHaveBeenCalled();
    expect(mockLogEvent).toHaveBeenCalledWith(
      { userId: 'u1', type: FileEvents.UNSHARE_FILE, metadata: { fileId: FILE_ID, ownerId: 'owner' } },
      { ability: 'ability', session: 'session' }
    );
  });
});
