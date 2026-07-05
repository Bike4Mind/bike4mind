import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { remove } from './remove';
import { ITagRepository } from '@bike4mind/common';

describe('tagService - remove', () => {
  const userId = 'test-user-123';
  const existingTagId = 'existing-tag-123';
  let mockTagRepo: Pick<ITagRepository, 'findByIdAndUserId' | 'delete'>;
  let adapters: { db: { tags: Pick<ITagRepository, 'findByIdAndUserId' | 'delete'> } };

  beforeEach(() => {
    mockTagRepo = {
      delete: vi.fn(),
      findByIdAndUserId: vi.fn(),
    };
    adapters = {
      db: {
        tags: mockTagRepo,
      },
    };
  });

  it('should successfully delete an existing tag', async () => {
    // Arrange
    const params = {
      id: existingTagId,
    };

    const existingTag = {
      id: existingTagId,
      userId,
      name: 'Test Tag',
      fileCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingTag);
    (mockTagRepo.delete as Mock).mockResolvedValueOnce(undefined);

    // Act
    await remove(userId, params, adapters);

    // Assert
    expect(mockTagRepo.findByIdAndUserId).toHaveBeenCalledWith(existingTagId, userId);
    expect(mockTagRepo.delete).toHaveBeenCalledWith(existingTagId);
  });

  it('should throw an error when tag is not found', async () => {
    // Arrange
    const params = {
      id: 'non-existent-id',
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    // Act & Assert
    await expect(remove(userId, params, adapters)).rejects.toThrow('Tag Service - Delete: Tag not found');
    expect(mockTagRepo.delete).not.toHaveBeenCalled();
  });

  it('should validate input parameters', async () => {
    // Arrange
    const params = {
      id: 123, // Invalid type - should be string
    };

    // Act & Assert
    // @ts-expect-error Testing invalid types
    await expect(remove(userId, params, adapters)).rejects.toThrow('Invalid input: expected string, received number');
  });

  it('should handle delete operation failure', async () => {
    // Arrange
    const params = {
      id: existingTagId,
    };

    const existingTag = {
      id: existingTagId,
      userId,
      name: 'Test Tag',
      fileCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingTag);
    (mockTagRepo.delete as Mock).mockRejectedValueOnce(new Error('Database error'));

    // Act & Assert
    await expect(remove(userId, params, adapters)).rejects.toThrow('Database error');
    expect(mockTagRepo.findByIdAndUserId).toHaveBeenCalledWith(existingTagId, userId);
    expect(mockTagRepo.delete).toHaveBeenCalledWith(existingTagId);
  });
});
