import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from './create';
import { IArtifactRepository, IArtifactContentRepository, IArtifactVersionRepository } from '@bike4mind/common';

describe('artifactService - create', () => {
  const userId = 'test-user-id';
  let mockArtifactRepo: Partial<IArtifactRepository>;
  let mockContentRepo: Partial<IArtifactContentRepository>;
  let mockVersionRepo: Partial<IArtifactVersionRepository>;
  let adapters: any;

  beforeEach(() => {
    mockArtifactRepo = {
      create: vi.fn(),
    };

    mockContentRepo = {
      create: vi.fn(),
    };

    mockVersionRepo = {
      create: vi.fn(),
    };

    adapters = {
      db: {
        artifacts: mockArtifactRepo,
        artifactContents: mockContentRepo,
        artifactVersions: mockVersionRepo,
      },
    };
  });

  it('should create a React artifact successfully', async () => {
    // Arrange
    const params = {
      type: 'react' as const,
      title: 'Test React Component',
      description: 'A test React component',
      content: 'function TestComponent() { return <div>Hello</div>; }',
      visibility: 'private' as const,
      tags: [],
      permissions: {
        canRead: [],
        canWrite: [],
        canDelete: [],
        isPublic: false,
        inheritFromProject: true,
      },
      metadata: {},
    };

    const mockContent = { _id: 'content-id-123', id: 'content-id-123' };
    const mockVersion = { _id: 'version-id-123' };
    const mockArtifact = { id: 'artifact-id-123' };

    (mockContentRepo.create as any).mockResolvedValueOnce(mockContent);
    (mockVersionRepo.create as any).mockResolvedValueOnce(mockVersion);
    (mockArtifactRepo.create as any).mockResolvedValueOnce(mockArtifact);

    // Act
    const result = await create(userId, params, adapters);

    // Assert
    expect(result).toEqual({
      artifact: mockArtifact,
      content: mockContent,
      version: mockVersion,
    });

    expect(mockContentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        content: params.content,
        mimeType: 'text/javascript',
      })
    );

    expect(mockVersionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        changes: ['Initial version'],
        createdBy: userId,
        isActive: true,
      })
    );

    expect(mockArtifactRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'react',
        title: params.title,
        description: params.description,
        userId,
        version: 1,
        status: 'draft',
        visibility: 'private',
      })
    );
  });

  it('should handle validation errors', async () => {
    // Arrange
    const invalidParams = {
      type: 'react' as const,
      title: '', // Invalid: empty title
      content: 'test content',
      visibility: 'private' as const,
      tags: [],
      metadata: {},
    };

    // Act & Assert
    await expect(create(userId, invalidParams, adapters)).rejects.toThrow();
  });

  it('should create artifact with custom permissions', async () => {
    // Arrange
    const params = {
      type: 'html' as const,
      title: 'Test HTML',
      content: '<div>Hello World</div>',
      visibility: 'private' as const,
      tags: [],
      permissions: {
        canRead: ['user1', 'user2'],
        canWrite: ['user1'],
        canDelete: ['user1'],
        isPublic: true,
        inheritFromProject: false,
      },
      metadata: {},
    };

    const mockContent = { _id: 'content-id', id: 'content-id' };
    const mockVersion = { _id: 'version-id' };
    const mockArtifact = { id: 'artifact-id' };

    (mockContentRepo.create as any).mockResolvedValueOnce(mockContent);
    (mockVersionRepo.create as any).mockResolvedValueOnce(mockVersion);
    (mockArtifactRepo.create as any).mockResolvedValueOnce(mockArtifact);

    // Act
    await create(userId, params, adapters);

    // Assert
    expect(mockArtifactRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: expect.objectContaining({
          canRead: ['user1', 'user2'],
          canWrite: ['user1'],
          canDelete: ['user1'],
          isPublic: true,
          inheritFromProject: false,
        }),
      })
    );
  });
});
