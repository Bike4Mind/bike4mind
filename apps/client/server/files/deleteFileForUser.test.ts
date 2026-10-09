import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileEvents } from '@bike4mind/common';

const { mockFindById, mockDeleteFabFile, mockFindUser, mockChangeStorageSize, mockLogEvent, mockRecompute } =
  vi.hoisted(() => ({
    mockFindById: vi.fn(),
    mockDeleteFabFile: vi.fn(),
    mockFindUser: vi.fn(),
    mockChangeStorageSize: vi.fn(),
    mockLogEvent: vi.fn(),
    mockRecompute: vi.fn(),
  }));

vi.mock('@bike4mind/database', () => ({
  changeStorageSize: mockChangeStorageSize,
  dataLakeRepository: {},
  fabFileChunkRepository: {},
  fabFileRepository: { findById: mockFindById },
  fileTagRepository: { touchLastActivityBy: vi.fn() },
  sessionRepository: {},
  userRepository: {},
  withTransaction: (fn: (session: unknown) => unknown) => fn('session'),
  User: { findById: (id: string) => ({ session: () => mockFindUser(id) }) },
}));
vi.mock('@bike4mind/services', () => ({ fabFilesService: { deleteFabFile: mockDeleteFabFile } }));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: () => false }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: mockLogEvent }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn() }));
vi.mock('@server/dataLakes/recomputeStatsForLakeTags', () => ({ recomputeStatsForLakeTags: mockRecompute }));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({ lakeConfigAuditPrincipal: () => undefined }));
vi.mock('@server/dataLakes/lakeMembershipAuditDb', () => ({ lakeMembershipAuditDb: {} }));

import { deleteFileForUser } from './deleteFileForUser';

const FILE_ID = '507f1f77bcf86cd799439011';
const logger = { error: vi.fn() };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an Express Request carries far more than this helper reads
const req = { user: { id: 'u1' }, logger, ability: 'ability' } as any;

/** Resolves deleteFabFile with `action`, reporting `size` freed bytes through onDeleteComplete. */
function deleteResolves(action: string, size = 0, fabFile?: unknown) {
  mockDeleteFabFile.mockImplementation(async (_userId, _params, adapters) => {
    if (size) await adapters.onDeleteComplete(fabFile, size);
    return { action, fabFile };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue({ userId: 'u1', tags: [] });
  mockFindUser.mockResolvedValue({ save: vi.fn() });
});

describe('deleteFileForUser', () => {
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
    mockFindById.mockResolvedValue({ userId: 'owner', tags: [] });
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
