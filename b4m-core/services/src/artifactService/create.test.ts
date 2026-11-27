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
      assertSourceRefsAccessible: vi.fn().mockResolvedValue(undefined),
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
        // _ids from the content/version writes must thread into the artifact record
        contentId: 'content-id-123',
        currentVersionId: 'version-id-123',
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

  it('rejects a source quest the actor cannot access before writing anything', async () => {
    adapters.assertSourceRefsAccessible.mockRejectedValueOnce(new Error('no access to quest'));

    await expect(
      create(userId, { type: 'react', title: 'T', content: 'x', sourceQuestId: 'foreign-quest' } as any, adapters)
    ).rejects.toThrow('no access to quest');

    expect(adapters.assertSourceRefsAccessible).toHaveBeenCalledWith(userId, {
      sessionId: undefined,
      sourceQuestId: 'foreign-quest',
      parentArtifactId: undefined,
    });
    expect(mockContentRepo.create).not.toHaveBeenCalled();
    expect(mockVersionRepo.create).not.toHaveBeenCalled();
    expect(mockArtifactRepo.create).not.toHaveBeenCalled();
  });

  it('hands the adapter each reference under its own key', async () => {
    vi.mocked(mockContentRepo.create!).mockResolvedValueOnce({ _id: 'c1' } as never);
    vi.mocked(mockVersionRepo.create!).mockResolvedValueOnce({ _id: 'v1' } as never);
    vi.mocked(mockArtifactRepo.create!).mockResolvedValueOnce({ id: 'a1' } as never);

    await create(
      userId,
      {
        type: 'react',
        title: 'T',
        content: 'x',
        sessionId: 's-1',
        sourceQuestId: 'q-1',
        parentArtifactId: 'p-1',
      } as never,
      adapters
    );

    expect(adapters.assertSourceRefsAccessible).toHaveBeenCalledWith(userId, {
      sessionId: 's-1',
      sourceQuestId: 'q-1',
      parentArtifactId: 'p-1',
    });
  });

  it('invokes the reference adapter even when the create carries no references', async () => {
    vi.mocked(mockContentRepo.create!).mockResolvedValueOnce({ _id: 'c1' } as never);
    vi.mocked(mockVersionRepo.create!).mockResolvedValueOnce({ _id: 'v1' } as never);
    vi.mocked(mockArtifactRepo.create!).mockResolvedValueOnce({ id: 'a1' } as never);

    await create(userId, { type: 'react', title: 'T', content: 'x' } as never, adapters);

    expect(adapters.assertSourceRefsAccessible).toHaveBeenCalledTimes(1);
    expect(adapters.assertSourceRefsAccessible).toHaveBeenCalledWith(userId, {
      sessionId: undefined,
      sourceQuestId: undefined,
      parentArtifactId: undefined,
    });
  });

  it('stores the reply identifier on the artifact row', async () => {
    vi.mocked(mockContentRepo.create!).mockResolvedValueOnce({ _id: 'c1' } as never);
    vi.mocked(mockVersionRepo.create!).mockResolvedValueOnce({ _id: 'v1' } as never);
    vi.mocked(mockArtifactRepo.create!).mockResolvedValueOnce({ id: 'a1' } as never);

    await create(
      userId,
      { type: 'react', title: 'T', content: 'x', sessionId: 's-1', identifier: 'todo_app' } as never,
      adapters
    );

    expect(mockArtifactRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's-1', identifier: 'todo_app' })
    );
  });
});
