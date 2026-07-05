import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { create } from './create';
import { IFileTagRepository, TagType } from '@bike4mind/common';

describe('tagService - create', () => {
  const userId = 'test-user-123';
  let mockFileTagRepo: Pick<IFileTagRepository, 'create'>;
  let adapters: { db: { fileTags: Pick<IFileTagRepository, 'create'> } };

  beforeEach(() => {
    mockFileTagRepo = {
      create: vi.fn(),
    };
    adapters = {
      db: {
        fileTags: mockFileTagRepo,
      },
    };
  });

  it('should create a file tag with minimal required parameters', async () => {
    // Arrange
    const params = {
      name: 'Test Tag',
      type: TagType.FILE,
    };

    const expectedInput = {
      userId,
      name: params.name,
      type: params.type,
      fileCount: 0,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
      lastActivityAt: expect.any(Date),
    };

    const mockResponse = { ...expectedInput, id: 'mock-id-123' };
    (mockFileTagRepo.create as Mock).mockResolvedValueOnce(mockResponse);

    // Act
    const result = await create(userId, params, adapters);

    // Assert
    expect(result).toEqual(mockResponse);
    expect(mockFileTagRepo.create).toHaveBeenCalledWith(expectedInput);
  });

  it('should create a file tag with all optional parameters', async () => {
    // Arrange
    const params = {
      name: 'Test Tag',
      type: TagType.FILE,
      icon: '📁',
      description: 'Test Description',
      color: '#FF0000',
    };

    const expectedInput = {
      userId,
      name: params.name,
      type: params.type,
      icon: params.icon,
      description: params.description,
      color: params.color,
      fileCount: 0,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
      lastActivityAt: expect.any(Date),
    };

    const mockResponse = { ...expectedInput, id: 'mock-id-123' };
    (mockFileTagRepo.create as Mock).mockResolvedValueOnce(mockResponse);

    // Act
    const result = await create(userId, params, adapters);

    // Assert
    expect(result).toEqual(mockResponse);
    expect(mockFileTagRepo.create).toHaveBeenCalledWith(expectedInput);
  });

  it('should throw an error for invalid tag type', () => {
    // Arrange
    const params = {
      name: 'Test Tag',
      type: 'INVALID_TYPE' as TagType,
    };

    // Act & Assert
    expect(() => create(userId, params, adapters)).toThrow('Invalid option');
  });
});
