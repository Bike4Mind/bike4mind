import { describe, it, expect, beforeEach, Mock } from 'vitest';
import { createProject } from './create';
import { createMockProjectRepository } from '../__tests__/utils/testUtils';
import { createShareableFake } from '../__tests__/utils/shareableFake';
import { IProjectDocument, IProjectRepository } from '@bike4mind/common';

describe('projectService - create', () => {
  const userId = 'test-user-123';
  let mockProjectRepo: IProjectRepository;
  let adapters: {
    db: {
      projects: IProjectRepository;
      fabFiles: { shareable: ReturnType<typeof createShareableFake> };
      sessions: { shareable: ReturnType<typeof createShareableFake> };
    };
  };

  beforeEach(() => {
    mockProjectRepo = createMockProjectRepository();
    adapters = {
      db: {
        projects: mockProjectRepo,
        fabFiles: { shareable: createShareableFake([]) },
        sessions: { shareable: createShareableFake([]) },
      },
    };
  });

  it('should create a project with minimal required parameters', async () => {
    const params = {
      name: 'Test Project',
      description: 'Test Description',
    };

    const expectedProject: IProjectDocument = {
      id: 'test-project-id',
      name: params.name,
      description: params.description,
      userId,
      sessionIds: [],
      fileIds: [],
      systemPrompts: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    };

    (mockProjectRepo.create as Mock).mockResolvedValueOnce(expectedProject);

    const result = await createProject({ id: userId }, params, adapters);

    expect(result).toEqual(expectedProject);
    expect(mockProjectRepo.create).toHaveBeenCalledWith({
      name: params.name,
      description: params.description,
      userId,
      sessionIds: [],
      fileIds: [],
      systemPrompts: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it('should create a project with optional parameters', async () => {
    const params = {
      name: 'Test Project',
      description: 'Test Description',
      sessionIds: ['session-1', 'session-2'],
      fileIds: ['file-1', 'file-2'],
    };

    // All owned by the creator, so both lists fully resolve.
    adapters.db.fabFiles = {
      shareable: createShareableFake(params.fileIds.map(id => ({ id, userId, users: [], groups: [] }))),
    };
    adapters.db.sessions = {
      shareable: createShareableFake(params.sessionIds.map(id => ({ id, userId, users: [], groups: [] }))),
    };

    const expectedProject: IProjectDocument = {
      id: 'test-project-id',
      name: params.name,
      description: params.description,
      userId,
      sessionIds: params.sessionIds,
      fileIds: params.fileIds,
      systemPrompts: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    };

    (mockProjectRepo.create as Mock).mockResolvedValueOnce(expectedProject);

    const result = await createProject({ id: userId }, params, adapters);

    expect(result).toEqual(expectedProject);
    expect(mockProjectRepo.create).toHaveBeenCalledWith({
      name: params.name,
      description: params.description,
      userId,
      sessionIds: params.sessionIds,
      fileIds: params.fileIds,
      systemPrompts: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it('should throw validation error for invalid parameters', async () => {
    const invalidParams = {
      name: '', // Invalid: empty string
      description: '', // Invalid: empty string
    };

    await expect(createProject({ id: userId }, invalidParams, adapters)).rejects.toThrow();
  });
});
