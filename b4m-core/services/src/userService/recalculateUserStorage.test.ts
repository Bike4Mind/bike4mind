import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recalculateUserStorage, RecalculateUserStorageParameters } from './recalculateUserStorage';
import { NotFoundError } from '@bike4mind/utils';
import { createMockFabFileRepository, createMockUserRepository, createMockUser } from '../__tests__/utils/testUtils';

const baseParams: RecalculateUserStorageParameters = {
  userId: 'test-user-id',
};

describe('recalculateUserStorage', () => {
  let mockAdapters: any;
  let mockUser: any;
  let mockFabFiles: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = createMockUser({ currentStorageSize: 0 });
    mockFabFiles = [
      { fileSize: 100 },
      { fileSize: 200 },
      { fileSize: 0 },
      {}, // file with no fileSize
    ];
    mockAdapters = {
      db: {
        users: createMockUserRepository(),
        fabFiles: createMockFabFileRepository(),
      },
    };
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.fabFiles.findByUserId.mockResolvedValue(mockFabFiles);
    mockAdapters.db.users.update.mockResolvedValue(undefined);
  });

  it('should recalculate and update user storage size correctly', async () => {
    await recalculateUserStorage(baseParams, mockAdapters);
    expect(mockAdapters.db.users.findById).toHaveBeenCalledWith(baseParams.userId);
    expect(mockAdapters.db.fabFiles.findByUserId).toHaveBeenCalledWith(baseParams.userId);
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(expect.objectContaining({ currentStorageSize: 300 }));
  });

  it('should set storage size to 0 if user has no files', async () => {
    mockAdapters.db.fabFiles.findByUserId.mockResolvedValue([]);
    await recalculateUserStorage(baseParams, mockAdapters);
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(expect.objectContaining({ currentStorageSize: 0 }));
  });

  it('should throw NotFoundError if user is not found', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(null);
    await expect(recalculateUserStorage(baseParams, mockAdapters)).rejects.toThrow(NotFoundError);
  });

  it('should treat missing fileSize as 0', async () => {
    mockFabFiles = [{ fileSize: 50 }, {}, { fileSize: undefined }, { fileSize: 25 }];
    mockAdapters.db.fabFiles.findByUserId.mockResolvedValue(mockFabFiles);
    await recalculateUserStorage(baseParams, mockAdapters);
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(expect.objectContaining({ currentStorageSize: 75 }));
  });
});
