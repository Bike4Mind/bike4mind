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

describe('projectService - addSessions', () => {
  const userId = 'test-user-123';
  // Owns the sessions and files the mockUser tests add, so grantCap lets the owner grant through
  // unchanged. The cap itself is pinned in addSessions.authorization.test.ts.
  const adderId = 'adder-123';
  const ownerGrant = {
    userId,
    permissions: [Permission.read, Permission.update],
    projectId: 'test-project-id',
    sessionId: undefined,
  };
  let mockProjectRepo: IProjectRepository;
  let mockSessionRepo: ISessionRepository;
  let mockFabFileRepo: IFabFileRepository;
  let mockUser: IUserDocument;
  let adapters: { db: { projects: IProjectRepository; sessions: ISessionRepository; fabFiles: IFabFileRepository } };
  let sessionWrites: unknown[];
  let fabFileWrites: unknown[];

  beforeEach(() => {
    mockProjectRepo = createMockProjectRepository();
    mockSessionRepo = createMockSessionRepository();
    mockFabFileRepo = createMockFabFileRepository();
    mockUser = { ...createMockUser(), id: adderId } as unknown as IUserDocument;
    // Cloned at call time: pushShareable mutates `users` in place, so mock.calls would also match a
    // write made before the grants were pushed.
    sessionWrites = [];
    fabFileWrites = [];
    (mockSessionRepo.update as Mock).mockImplementation(async (partial: unknown) => {
      sessionWrites.push(structuredClone(partial));
    });
    (mockFabFileRepo.update as Mock).mockImplementation(async (partial: unknown) => {
      fabFileWrites.push(structuredClone(partial));
    });

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

    // A fresh set per session lookup, so each session's file writes are checked on their own objects.
    const makeFiles = () =>
      knowledgeFileIds.map(id => ({
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

    (mockProjectRepo.shareable.findUpdateAccessById as Mock).mockResolvedValueOnce(mockProject);
    (mockSessionRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce(mockSessions);
    (mockFabFileRepo.shareable.findAllAccessibleByIds as Mock)
      .mockResolvedValueOnce(makeFiles())
      .mockResolvedValueOnce(makeFiles());

    const result = await addSessions(mockContributor, { projectId, sessionIds }, adapters);

    expect(result).toEqual(mockSessions);

    expect(mockProjectRepo.update).not.toHaveBeenCalled();
    expect(mockProjectRepo.updateWithUpdateAccess).toHaveBeenCalledTimes(1);
    expect((mockProjectRepo.updateWithUpdateAccess as Mock).mock.calls[0]).toStrictEqual([
      mockContributor,
      {
        id: projectId,
        sessionIds: [...existingSessionIds, ...sessionIds],
        fileIds: knowledgeFileIds,
        updatedAt: expect.any(Date),
      },
    ]);
    expect((mockProjectRepo.updateWithUpdateAccess as Mock).mock.calls[0][0]).toBe(mockContributor);

    const sharedUsers = [
      { userId: projectOwnerId, permissions: [Permission.read, Permission.update], projectId, sessionId: undefined },
      { userId: contributorId, permissions: [Permission.read], projectId, sessionId: undefined },
    ];
    expect(mockSessionRepo.update).toHaveBeenCalledTimes(sessionIds.length);
    sessionIds.forEach((id, i) => {
      expect(sessionWrites[i]).toStrictEqual({ id, users: sharedUsers });
    });
    expect(mockFabFileRepo.shareable.findAllAccessibleByIds).toHaveBeenCalledTimes(sessionIds.length);
    expect(mockFabFileRepo.update).toHaveBeenCalledTimes(sessionIds.length * knowledgeFileIds.length);
    fabFileWrites.forEach((partial, i) => {
      expect(partial).toStrictEqual({ id: knowledgeFileIds[i % knowledgeFileIds.length], users: sharedUsers });
    });
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

    (mockProjectRepo.shareable.findUpdateAccessById as Mock).mockResolvedValueOnce(mockProject);
    (mockSessionRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce(mockSessions);

    const result = await addSessions(mockContributor, { projectId, sessionIds }, adapters);

    expect(result).toEqual(mockSessions);
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
    expect(mockProjectRepo.updateWithUpdateAccess).toHaveBeenCalledTimes(1);
    expect((mockProjectRepo.updateWithUpdateAccess as Mock).mock.calls[0]).toStrictEqual([
      mockContributor,
      { id: projectId, sessionIds: [...existingSessionIds, ...sessionIds], fileIds: [], updatedAt: expect.any(Date) },
    ]);
    expect((mockProjectRepo.updateWithUpdateAccess as Mock).mock.calls[0][0]).toBe(mockContributor);

    const sharedUsers = [
      { userId: projectOwnerId, permissions: [Permission.read, Permission.update], projectId, sessionId: undefined },
      { userId: contributorId, permissions: [Permission.read], projectId, sessionId: undefined },
    ];
    expect(mockSessionRepo.update).toHaveBeenCalledTimes(sessionIds.length);
    sessionIds.forEach((id, i) => {
      expect(sessionWrites[i]).toStrictEqual({ id, users: sharedUsers });
    });
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
      userId: adderId,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUpdated: new Date(),
      firstCreated: new Date(),
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
    }));

    (mockProjectRepo.shareable.findUpdateAccessById as Mock).mockResolvedValueOnce(mockProject);
    (mockSessionRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce(mockSessions);
    const result = await addSessions(mockUser, { projectId, sessionIds }, adapters);

    expect(result).toEqual(mockSessions);
    expect(mockProjectRepo.shareable.findUpdateAccessById).toHaveBeenCalledWith(mockUser, projectId);
    expect(mockSessionRepo.shareable.findAllAccessibleByIds).toHaveBeenCalledTimes(1);
    expect(mockSessionRepo.shareable.findAllAccessibleByIds).toHaveBeenCalledWith(mockUser, sessionIds);
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
    expect(mockProjectRepo.updateWithUpdateAccess).toHaveBeenCalledTimes(1);
    expect((mockProjectRepo.updateWithUpdateAccess as Mock).mock.calls[0]).toStrictEqual([
      mockUser,
      { id: projectId, sessionIds: [...existingSessionIds, ...sessionIds], fileIds: [], updatedAt: expect.any(Date) },
    ]);
    expect((mockProjectRepo.updateWithUpdateAccess as Mock).mock.calls[0][0]).toBe(mockUser);
    // mockUser is not the project owner, so only the owner is granted.
    expect(mockSessionRepo.update).toHaveBeenCalledTimes(sessionIds.length);
    sessionIds.forEach((id, i) => {
      expect(sessionWrites[i]).toStrictEqual({ id, users: [ownerGrant] });
    });
  });

  it('should throw NotFoundError when sessions are not found', async () => {
    const projectId = 'test-project-id';
    const sessionIds = ['session-1', 'session-2'];
    (mockProjectRepo.shareable.findUpdateAccessById as Mock).mockResolvedValueOnce({
      id: projectId,
      userId,
      sessionIds: [],
      fileIds: [],
      users: [],
    });
    (mockSessionRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce([]);

    await expect(addSessions(mockUser, { projectId, sessionIds }, adapters)).rejects.toThrow(NotFoundError);
    expect(mockProjectRepo.shareable.findUpdateAccessById).toHaveBeenCalledWith(mockUser, projectId);
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
    expect(mockProjectRepo.updateWithUpdateAccess).not.toHaveBeenCalled();
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
    (mockProjectRepo.shareable.findUpdateAccessById as Mock).mockResolvedValueOnce(null);

    await expect(addSessions(mockUser, { projectId, sessionIds }, adapters)).rejects.toThrow(NotFoundError);
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
    expect(mockProjectRepo.updateWithUpdateAccess).not.toHaveBeenCalled();
  });

  it('should throw validation error for invalid parameters', async () => {
    const invalidParams = {
      projectId: '', // Invalid: empty string
      sessionIds: [], // Invalid: empty array
    };

    await expect(addSessions(mockUser, invalidParams, adapters)).rejects.toThrow();
    expect(mockSessionRepo.shareable.findAllAccessibleByIds).not.toHaveBeenCalled();
    expect(mockProjectRepo.shareable.findUpdateAccessById).not.toHaveBeenCalled();
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
    expect(mockProjectRepo.updateWithUpdateAccess).not.toHaveBeenCalled();
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
        userId: adderId,
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
      userId: adderId,
      users: [],
    }));

    (mockProjectRepo.shareable.findUpdateAccessById as Mock).mockResolvedValue(mockProject);
    (mockSessionRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValue(mockSessions);
    (mockFabFileRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValue(mockFiles);

    const result = await addSessions(mockUser, { projectId, sessionIds }, adapters);

    expect(result).toEqual(mockSessions);
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
    expect(mockProjectRepo.updateWithUpdateAccess).toHaveBeenCalledTimes(1);
    expect((mockProjectRepo.updateWithUpdateAccess as Mock).mock.calls[0]).toStrictEqual([
      mockUser,
      { id: projectId, sessionIds: sessionIds, fileIds: knowledgeFileIds, updatedAt: expect.any(Date) },
    ]);
    expect((mockProjectRepo.updateWithUpdateAccess as Mock).mock.calls[0][0]).toBe(mockUser);
    expect(mockFabFileRepo.shareable.findAllAccessibleByIds).toHaveBeenCalledTimes(1);
    expect(mockFabFileRepo.shareable.findAllAccessibleByIds).toHaveBeenCalledWith(mockUser, knowledgeFileIds);
    expect(mockSessionRepo.update).toHaveBeenCalledTimes(1);
    expect(sessionWrites[0]).toStrictEqual({ id: sessionIds[0], users: [ownerGrant] });
    expect(mockFabFileRepo.update).toHaveBeenCalledTimes(knowledgeFileIds.length);
    knowledgeFileIds.forEach((id, i) => {
      expect(fabFileWrites[i]).toStrictEqual({ id, users: [ownerGrant] });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
});
