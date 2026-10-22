import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError } from '@bike4mind/common';
import {
  RECALCULATE_STORAGE_MAX_ATTEMPTS,
  recalculateUserStorage,
  RecalculateUserStorageParameters,
} from './recalculateUserStorage';
import { NotFoundError } from '@bike4mind/utils';
import { createMockFabFileRepository, createMockUserRepository } from '../__tests__/utils/testUtils';

const baseParams: RecalculateUserStorageParameters = {
  userId: 'test-user-id',
};

describe('recalculateUserStorage', () => {
  let mockAdapters: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = {
      db: {
        users: createMockUserRepository(),
        fabFiles: createMockFabFileRepository(),
      },
    };
    mockAdapters.db.users.findCurrentStorageSize.mockResolvedValue(500);
    mockAdapters.db.fabFiles.sumFileSizeByUserId.mockResolvedValue(300);
    mockAdapters.db.users.setCurrentStorageIfUnchanged.mockResolvedValue(true);
  });

  it('sets the counter to the recalculated size, conditioned on the value it read', async () => {
    const result = await recalculateUserStorage(baseParams, mockAdapters);
    expect(mockAdapters.db.fabFiles.sumFileSizeByUserId).toHaveBeenCalledWith(baseParams.userId);
    expect(mockAdapters.db.users.setCurrentStorageIfUnchanged).toHaveBeenCalledWith('test-user-id', 500, 300);
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ counter: 500, truth: 300, drift: 200, repaired: true, conflict: false });
  });

  it('sets storage size to 0 if user has no files', async () => {
    mockAdapters.db.fabFiles.sumFileSizeByUserId.mockResolvedValue(0);
    await recalculateUserStorage(baseParams, mockAdapters);
    expect(mockAdapters.db.users.setCurrentStorageIfUnchanged).toHaveBeenCalledWith('test-user-id', 500, 0);
  });

  it('skips the write when the counter already matches', async () => {
    mockAdapters.db.fabFiles.sumFileSizeByUserId.mockResolvedValue(500);
    const result = await recalculateUserStorage(baseParams, mockAdapters);
    expect(mockAdapters.db.users.setCurrentStorageIfUnchanged).not.toHaveBeenCalled();
    expect(result).toMatchObject({ drift: 0, repaired: false, conflict: false });
  });

  it('re-reads and retries when a concurrent adjustment moved the counter', async () => {
    mockAdapters.db.users.findCurrentStorageSize.mockResolvedValueOnce(500).mockResolvedValueOnce(700);
    mockAdapters.db.users.setCurrentStorageIfUnchanged.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const result = await recalculateUserStorage(baseParams, mockAdapters);

    expect(mockAdapters.db.users.setCurrentStorageIfUnchanged).toHaveBeenNthCalledWith(1, 'test-user-id', 500, 300);
    expect(mockAdapters.db.users.setCurrentStorageIfUnchanged).toHaveBeenNthCalledWith(2, 'test-user-id', 700, 300);
    expect(result).toMatchObject({ counter: 700, repaired: true });
  });

  it('gives up with a ConflictError after repeated conflicts', async () => {
    mockAdapters.db.users.setCurrentStorageIfUnchanged.mockResolvedValue(false);
    await expect(recalculateUserStorage(baseParams, mockAdapters)).rejects.toThrow(ConflictError);
    expect(mockAdapters.db.users.setCurrentStorageIfUnchanged).toHaveBeenCalledTimes(RECALCULATE_STORAGE_MAX_ATTEMPTS);
  });

  it('should throw NotFoundError if user is not found', async () => {
    mockAdapters.db.users.findCurrentStorageSize.mockResolvedValue(null);
    await expect(recalculateUserStorage(baseParams, mockAdapters)).rejects.toThrow(NotFoundError);
  });
});
