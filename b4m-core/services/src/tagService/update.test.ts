import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { update } from './update';
import { ITagRepository } from '@bike4mind/common';

describe('tagService - update', () => {
  const userId = 'test-user-123';
  const existingTagId = 'existing-tag-123';
  let mockTagRepo: Pick<ITagRepository, 'update' | 'findByIdAndUserId'>;
  let adapters: { db: { tags: Pick<ITagRepository, 'update' | 'findByIdAndUserId'> } };

  beforeEach(() => {
    mockTagRepo = {
      update: vi.fn(),
      findByIdAndUserId: vi.fn(),
    };
    adapters = {
      db: {
        tags: mockTagRepo,
      },
    };
  });

  it('should update a tag with partial parameters', async () => {
    // Arrange
    const existingTag = {
      id: existingTagId,
      userId,
      name: 'Original Name',
      icon: '📁',
      description: 'Original Description',
      color: '#000000',
      fileCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    };

    const params = {
      id: existingTagId,
      name: 'Updated Name',
      description: 'Updated Description',
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingTag);
    (mockTagRepo.update as Mock).mockResolvedValueOnce({ ...existingTag, ...params });

    // Act
    const result = await update(userId, params, adapters);

    // Assert
    expect(mockTagRepo.findByIdAndUserId).toHaveBeenCalledWith(existingTagId, userId);
    expect(mockTagRepo.update).toHaveBeenCalledWith({
      id: existingTagId,
      name: 'Updated Name',
      description: 'Updated Description',
      updatedAt: expect.any(Date),
    });
    expect(result).toEqual({
      id: existingTagId,
      name: 'Updated Name',
      description: 'Updated Description',
      updatedAt: expect.any(Date),
    });
  });

  it('should throw an error when tag is not found', async () => {
    // Arrange
    const params = {
      id: 'non-existent-id',
      name: 'Updated Name',
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    // Act & Assert
    await expect(update(userId, params, adapters)).rejects.toThrow('Tag Service - Update: Tag not found');
    expect(mockTagRepo.update).not.toHaveBeenCalled();
  });

  it('should update a tag with all optional parameters', async () => {
    // Arrange
    const existingTag = {
      id: existingTagId,
      userId,
      name: 'Original Name',
      icon: '📁',
      description: 'Original Description',
      color: '#000000',
      fileCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    };

    const params = {
      id: existingTagId,
      name: 'Updated Name',
      icon: '📂',
      description: 'Updated Description',
      color: '#FF0000',
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingTag);
    (mockTagRepo.update as Mock).mockResolvedValueOnce({ ...existingTag, ...params });

    // Act
    const result = await update(userId, params, adapters);

    // Assert
    expect(mockTagRepo.findByIdAndUserId).toHaveBeenCalledWith(existingTagId, userId);
    expect(mockTagRepo.update).toHaveBeenCalledWith({
      id: existingTagId,
      name: 'Updated Name',
      icon: '📂',
      description: 'Updated Description',
      color: '#FF0000',
      updatedAt: expect.any(Date),
    });
    expect(result).toEqual({
      id: existingTagId,
      name: 'Updated Name',
      icon: '📂',
      description: 'Updated Description',
      color: '#FF0000',
      updatedAt: expect.any(Date),
    });
  });

  it('should validate input parameters', async () => {
    // Arrange
    const params = {
      id: 123, // Invalid type - should be string
      name: true, // Invalid type - should be string
    };

    // Act & Assert
    // @ts-expect-error Testing invalid types
    await expect(update(userId, params, adapters)).rejects.toThrow('Invalid input: expected string, received number');
  });
});
