import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { createProject } from './create';
import { createMockProjectRepository } from '../__tests__/utils/testUtils';
import { createShareableFake } from '../__tests__/utils/shareableFake';
import { IProjectDocument, IProjectRepository, attachOrgApiKeyReach, orgApiKeyReachOf } from '@bike4mind/common';

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

  it('creates a project with no description', async () => {
    await createProject({ id: userId }, { name: 'No description' }, adapters);

    expect(mockProjectRepo.create).toHaveBeenCalledWith(expect.objectContaining({ description: '' }));
  });

  it('should throw validation error for invalid parameters', async () => {
    const invalidParams = {
      name: '', // Invalid: empty string
      description: '',
    };

    await expect(createProject({ id: userId }, invalidParams, adapters)).rejects.toThrow();
  });

  it('checks file and session readability without the caller org key reach', async () => {
    adapters.db.fabFiles = { shareable: createShareableFake([{ id: 'file-1', userId, users: [], groups: [] }]) };
    adapters.db.sessions = { shareable: createShareableFake([{ id: 'session-1', userId, users: [], groups: [] }]) };
    const fileSpy = vi.spyOn(adapters.db.fabFiles.shareable, 'findAllAccessibleByIds');
    const sessionSpy = vi.spyOn(adapters.db.sessions.shareable, 'findAllAccessibleByIds');
    const keyUser = attachOrgApiKeyReach(
      { id: userId, groups: ['group-1'] },
      { organizationId: 'org-1', readGroupIds: ['group-2'], dataLakeOrgIds: [] }
    );

    await createProject(keyUser, { name: 'P', fileIds: ['file-1'], sessionIds: ['session-1'] }, adapters);

    for (const spy of [fileSpy, sessionSpy]) {
      expect(spy).toHaveBeenCalledTimes(1);
      const [accessor] = spy.mock.calls[0]!;
      expect(orgApiKeyReachOf(accessor)).toBeUndefined();
      expect(accessor).toMatchObject({ id: userId, groups: ['group-1'] });
    }
  });
});
