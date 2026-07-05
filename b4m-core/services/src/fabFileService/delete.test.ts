import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { UnauthorizedError } from '@bike4mind/utils';
import { deleteFabFile } from './delete';
import { IFabFileDocument } from '@bike4mind/common';

describe('deleteFabFile', () => {
  const mockUserId = 'user-123';
  const mockFileId = 'file-456';
  const mockOwnerId = 'owner-789';

  const mockFabFile: Partial<IFabFileDocument> = {
    id: mockFileId,
    userId: mockUserId,
    fileName: 'test-file.txt',
    filePath: 'uploads/test-file.txt',
    fileSize: 1024,
    users: [],
  };

  const createMockSharedFile = (): Partial<IFabFileDocument> => ({
    id: mockFileId,
    userId: mockOwnerId,
    fileName: 'shared-file.txt',
    filePath: 'uploads/shared-file.txt',
    fileSize: 2048,
    users: [{ userId: mockUserId, permissions: ['read'] }],
  });

  let mockAdapter: {
    db: {
      fabFiles: {
        findByIdAndUserId: Mock;
        findById: Mock;
        findAllInIds: Mock;
        update: Mock;
        deleteManyInIds: Mock;
      };
      fabFileChunks: {
        deleteManyByFabFileId: Mock;
      };
      users: {
        findById: Mock;
        update: Mock;
      };
      sessions: {
        findAllWithKnowledgeId: Mock;
        update: Mock;
      };
    };
    storage: {
      delete: Mock;
    };
    onDeleteComplete?: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockAdapter = {
      db: {
        fabFiles: {
          findByIdAndUserId: vi.fn(),
          findById: vi.fn(),
          findAllInIds: vi.fn(),
          update: vi.fn(),
          deleteManyInIds: vi.fn(),
        },
        fabFileChunks: {
          deleteManyByFabFileId: vi.fn(),
        },
        users: {
          findById: vi.fn().mockResolvedValue({ id: mockUserId }),
          update: vi.fn(),
        },
        sessions: {
          findAllWithKnowledgeId: vi.fn().mockResolvedValue([]),
          update: vi.fn(),
        },
      },
      storage: {
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  it('should throw UnauthorizedError when user is not found', async () => {
    mockAdapter.db.users.findById.mockResolvedValue(null);

    await expect(deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter)).rejects.toThrow(UnauthorizedError);
  });

  describe('owned files', () => {
    it('should soft-delete owned file and return action "deleted"', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(mockFabFile);
      mockAdapter.db.fabFiles.update.mockResolvedValue(mockFabFile);

      const result = await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(result.action).toBe('deleted');
      expect(result.fabFile).toBe(mockFabFile);
      expect(mockAdapter.db.fabFiles.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: mockFileId, deletedAt: expect.any(Date) })
      );
      expect(mockAdapter.db.fabFileChunks.deleteManyByFabFileId).toHaveBeenCalledWith(mockFileId);
      expect(mockAdapter.storage.delete).toHaveBeenCalledWith('uploads/test-file.txt');
    });

    it('should call onDeleteComplete with correct size when file has fileSize', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(mockFabFile);
      mockAdapter.db.fabFiles.update.mockResolvedValue(mockFabFile);
      mockAdapter.onDeleteComplete = vi.fn().mockResolvedValue(undefined);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(mockAdapter.onDeleteComplete).toHaveBeenCalledWith(mockFabFile, 1024);
    });

    it('should skip S3 deletion when file has no filePath', async () => {
      const fileWithoutPath = { ...mockFabFile, filePath: undefined, fileSize: 0 };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(fileWithoutPath);
      mockAdapter.db.fabFiles.update.mockResolvedValue(fileWithoutPath);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(mockAdapter.storage.delete).not.toHaveBeenCalled();
    });

    it('should unlink file from associated sessions', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(mockFabFile);
      mockAdapter.db.fabFiles.update.mockResolvedValue(mockFabFile);
      mockAdapter.db.sessions.findAllWithKnowledgeId.mockResolvedValue([
        { id: 'session-1', knowledgeIds: [mockFileId, 'other-file'] },
        { id: 'session-2', knowledgeIds: [mockFileId] },
      ]);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(mockAdapter.db.sessions.update).toHaveBeenCalledWith({
        id: 'session-1',
        knowledgeIds: ['other-file'],
      });
      expect(mockAdapter.db.sessions.update).toHaveBeenCalledWith({
        id: 'session-2',
        knowledgeIds: [],
      });
    });
  });

  describe('shared files (self-unshare)', () => {
    it('should remove user from share list and return action "unshared"', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(null);
      mockAdapter.db.fabFiles.findById.mockResolvedValue(createMockSharedFile());

      const result = await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(result.action).toBe('unshared');
      expect(result.fabFile?.id).toBe(mockFileId);
      expect(mockAdapter.db.fabFiles.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: mockFileId,
          users: [],
        })
      );
      // Should NOT soft-delete or delete S3 objects
      expect(mockAdapter.storage.delete).not.toHaveBeenCalled();
      expect(mockAdapter.db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    });

    it('should clean up only the unsharing user sessions', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(null);
      mockAdapter.db.fabFiles.findById.mockResolvedValue(createMockSharedFile());
      mockAdapter.db.sessions.findAllWithKnowledgeId.mockResolvedValue([
        { id: 'session-1', userId: mockUserId, knowledgeIds: [mockFileId, 'other-file'] },
        { id: 'session-2', userId: mockOwnerId, knowledgeIds: [mockFileId] },
      ]);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      // Only the unsharing user's session should be cleaned up
      expect(mockAdapter.db.sessions.update).toHaveBeenCalledTimes(1);
      expect(mockAdapter.db.sessions.update).toHaveBeenCalledWith({
        id: 'session-1',
        knowledgeIds: ['other-file'],
      });
    });
  });

  describe('file not found', () => {
    it('should return action "not_found" when file does not exist at all', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(null);
      mockAdapter.db.fabFiles.findById.mockResolvedValue(null);

      const result = await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(result.action).toBe('not_found');
      expect(result.fabFile).toBeNull();
      expect(mockAdapter.db.fabFiles.update).not.toHaveBeenCalled();
      expect(mockAdapter.storage.delete).not.toHaveBeenCalled();
    });

    it('should return action "not_found" when file exists but user is not in share list', async () => {
      const fileNotSharedToUser: Partial<IFabFileDocument> = {
        ...createMockSharedFile(),
        users: [{ userId: 'other-user', permissions: ['read'] }],
      };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(null);
      mockAdapter.db.fabFiles.findById.mockResolvedValue(fileNotSharedToUser);

      const result = await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(result.action).toBe('not_found');
      expect(result.fabFile).toBeNull();
      expect(mockAdapter.db.fabFiles.update).not.toHaveBeenCalled();
    });
  });
});
