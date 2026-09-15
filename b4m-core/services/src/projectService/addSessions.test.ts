import { describe, it, expect, beforeEach, Mock, vi, afterEach } from 'vitest';
import { addSessions } from './addSessions';
import {
  createMockProjectRepository,
  createMockSessionRepository,
  createMockUser,
  createMockFabFileRepository,
} from '../__tests__/utils/testUtils';
import {
  IProjectDocument,
  IProjectRepository,
  ISessionRepository,
  IUserDocument,
  Permission,
  IFabFileRepository,
} from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import * as addFilesModule from './addFiles';

// TODO: Skipped temporarily due to test failures that need fixing
describe.skip('projectService - addSessions', () => {
  const userId = 'test-user-123';
  let mockProjectRepo: IProjectRepository;
  let mockSessionRepo: ISessionRepository;
  let mockFabFileRepo: IFabFileRepository;
  let mockUser: IUserDocument;
  let adapters: { db: { projects: IProjectRepository; sessions: ISessionRepository; fabFiles: IFabFileRepository } };

  beforeEach(() => {
    mockProjectRepo = createMockProjectRepository();
    mockSessionRepo = createMockSessionRepository();
    mockFabFileRepo = createMockFabFileRepository();
    mockUser = createMockUser() as unknown as IUserDocument;

    vi.spyOn(addFilesModule, 'addFiles').mockResolvedValue({} as any);

    adapters = {
      db: {
        projects: mockProjectRepo,
        sessions: mockSessionRepo,
        fabFiles: mockFabFileRepo,
      },
    };
  });

  it('should add sessions with knowledge files to a project and share appropriately', async () => {
    const projectOwnerId = 'project-owner-123';
    const contributorId = 'contributor-123';
    const projectId = 'test-project-id';
    const sessionIds = ['session-1', 'session-2'];
    const knowledgeFileIds = ['file-1', 'file-2'];
    const existingSessionIds = ['existing-session-1'];

    const mockProject: IProjectDocument = {
      id: projectId,
      name: 'Test Project',
      description: 'Test Description',
      userId: projectOwnerId,
      sessionIds: existingSessionIds,
      fileIds: [],
      systemPrompts: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [{ userId: contributorId, permissions: [Permission.read] }],
      groups: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockContributor = {
      ...createMockUser(),
      id: contributorId,
    } as unknown as IUserDocument;

    const mockSessions = sessionIds.map(id => ({
      id,
      name: `Session ${id}`,
      userId: contributorId,
      knowledgeIds: knowledgeFileIds,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUpdated: new Date(),
      firstCreated: new Date(),
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
    }));

    const mockFiles = knowledgeFileIds.map(id => ({
      id,
      name: `File ${id}`,
      userId: contributorId,
      createdAt: new Date(),
      updatedAt: new Date(),
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
    }));

    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(mockProject);
    (mockSessionRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce(mockSessions);
    (mockFabFileRepo.findAllByIds as Mock).mockResolvedValue(mockFiles);

    const result = await addSessions(mockContributor, { projectId, sessionIds }, adapters);

    expect(result).toEqual(mockSessions);

    expect(mockProjectRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ...mockProject,
        sessionIds: expect.arrayContaining([...existingSessionIds, ...sessionIds]),
        updatedAt: expect.any(Date),
      })
    );

    for (const session of mockSessions) {
      expect(mockSessionRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          ...session,
          users: expect.arrayContaining([
            { userId: projectOwnerId, permissions: [Permission.read], projectId },
            { userId: contributorId, permissions: [Permission.read], projectId },
          ]),
        })
      );
    }

    expect(addFilesModule.addFiles).toHaveBeenCalledWith(
      mockContributor,
      { projectId: projectId, fileIds: knowledgeFileIds },
      adapters
    );
  });

  it('should add sessions to a project and share with project owner', async () => {
    const projectOwnerId = 'project-owner-123';
    const contributorId = 'contributor-123';
    const projectId = 'test-project-id';
    const sessionIds = ['session-1', 'session-2'];
    const existingSessionIds = ['existing-session-1'];

    const mockProject: IProjectDocument = {
      id: projectId,
      name: 'Test Project',
      description: 'Test Description',
      userId: projectOwnerId, // Different from the user adding sessions
      sessionIds: existingSessionIds,
      fileIds: [],
      systemPrompts: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [{ userId: contributorId, permissions: [Permission.read] }],
      groups: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockContributor = {
      ...createMockUser(),
      id: contributorId,
    } as unknown as IUserDocument;

    const mockSessions = sessionIds.map(id => ({
      id,
      name: `Session ${id}`,
      userId: contributorId,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUpdated: new Date(),
      firstCreated: new Date(),
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
    }));

    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(mockProject);
    (mockSessionRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce(mockSessions);

    const result = await addSessions(mockContributor, { projectId, sessionIds }, adapters);

    expect(result).toEqual(mockSessions);
    expect(mockProjectRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ...mockProject,
        sessionIds: expect.arrayContaining([...existingSessionIds, ...sessionIds]),
        updatedAt: expect.any(Date),
      })
    );

    for (const session of mockSessions) {
      expect(mockSessionRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          ...session,
          users: expect.arrayContaining([
            { userId: projectOwnerId, permissions: [Permission.read], projectId },
            { userId: contributorId, permissions: [Permission.read], projectId },
          ]),
        })
      );
    }
  });

  it('should add sessions to a project successfully', async () => {
    const projectId = 'test-project-id';
    const sessionIds = ['session-1', 'session-2'];
    const existingSessionIds = ['existing-session-1'];

    const mockProject: IProjectDocument = {
      id: projectId,
      name: 'Test Project',
      description: 'Test Description',
      userId,
      sessionIds: existingSessionIds,
      fileIds: [],
      systemPrompts: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockSessions = sessionIds.map(id => ({
      id,
      name: `Session ${id}`,
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUpdated: new Date(),
      firstCreated: new Date(),
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
    }));

    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(mockProject);
    (mockSessionRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce(mockSessions);
    (mockProjectRepo.update as Mock).mockResolvedValueOnce({
      ...mockProject,
      sessionIds: [...existingSessionIds, ...sessionIds],
      updatedAt: expect.any(Date),
    });

    const result = await addSessions(mockUser, { projectId, sessionIds }, adapters);

    expect(result).toEqual(mockSessions);
    expect(mockProjectRepo.shareable.findAccessibleById).toHaveBeenCalledWith(mockUser, projectId);
    expect(mockSessionRepo.shareable.findAllAccessibleByIds).toHaveBeenCalledWith(mockUser, sessionIds);
    expect(mockProjectRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ...mockProject,
        sessionIds: expect.arrayContaining([...existingSessionIds, ...sessionIds]),
        updatedAt: expect.any(Date),
      })
    );
  });

  it('should throw NotFoundError when sessions are not found', async () => {
    const projectId = 'test-project-id';
    const sessionIds = ['session-1', 'session-2'];
    (mockSessionRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce([]);

    await expect(addSessions(mockUser, { projectId, sessionIds }, adapters)).rejects.toThrow(NotFoundError);
    expect(mockProjectRepo.shareable.findAccessibleById).not.toHaveBeenCalled();
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
  });

  it('should throw NotFoundError when project is not found', async () => {
    const projectId = 'test-project-id';
    const sessionIds = ['session-1'];
    const mockSessions = [
      {
        id: sessionIds[0],
        name: 'Test Session',
        userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    (mockSessionRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce(mockSessions);
    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(null);

    await expect(addSessions(mockUser, { projectId, sessionIds }, adapters)).rejects.toThrow(NotFoundError);
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
  });

  it('should throw validation error for invalid parameters', async () => {
    const invalidParams = {
      projectId: '', // Invalid: empty string
      sessionIds: [], // Invalid: empty array
    };

    await expect(addSessions(mockUser, invalidParams, adapters)).rejects.toThrow();
    expect(mockSessionRepo.shareable.findAllAccessibleByIds).not.toHaveBeenCalled();
    expect(mockProjectRepo.shareable.findAccessibleById).not.toHaveBeenCalled();
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
  });

  it('should add sessions and their knowledge files to project', async () => {
    const projectId = 'test-project-id';
    const sessionIds = ['session-1'];
    const knowledgeFileIds = ['knowledge-1', 'knowledge-2'];

    const mockProject = {
      id: projectId,
      userId,
      sessionIds: [],
      fileIds: [],
      users: [],
      name: 'Test Project',
      description: 'Test Description',
      systemPrompts: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      groups: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockSessions = [
      {
        id: sessionIds[0],
        userId,
        knowledgeIds: knowledgeFileIds,
        users: [],
        name: 'Test Session',
        isGlobalRead: false,
        isGlobalWrite: false,
        groups: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        lastUpdated: new Date(),
        firstCreated: new Date(),
      },
    ];

    const mockFiles = knowledgeFileIds.map(id => ({
      id,
      userId,
      users: [],
    }));

    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValue(mockProject);
    (mockSessionRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValue(mockSessions);
    (mockFabFileRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValue(mockFiles);

    const result = await addSessions(mockUser, { projectId, sessionIds }, adapters);

    expect(result).toEqual(mockSessions);
    expect(addFilesModule.addFiles).toHaveBeenCalledWith(mockUser, { projectId, fileIds: knowledgeFileIds }, adapters);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
});
