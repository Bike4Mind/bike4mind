import { describe, it, expect, beforeEach, Mock } from 'vitest';
import { deleteProject } from './delete';
import {
  createMockProjectRepository,
  createMockFabFileRepository,
  createMockSessionRepository,
  createMockUserRepository,
} from '../__tests__/utils/testUtils';
import {
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionRepository,
  IUserRepository,
} from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

describe('projectService - delete', () => {
  const userId = 'test-user-123';
  let mockProjectRepo: IProjectRepository;
  let mockFabFileRepo: IFabFileRepository;
  let mockSessionRepo: ISessionRepository;
  let mockUserRepo: IUserRepository;
  let adapters: {
    db: {
      projects: IProjectRepository;
      sessions: ISessionRepository;
      fabFiles: IFabFileRepository;
      users: IUserRepository;
    };
  };

  beforeEach(() => {
    mockProjectRepo = createMockProjectRepository();
    mockFabFileRepo = createMockFabFileRepository();
    mockSessionRepo = createMockSessionRepository();
    mockUserRepo = createMockUserRepository();
    adapters = {
      db: {
        projects: mockProjectRepo,
        sessions: mockSessionRepo,
        fabFiles: mockFabFileRepo,
        users: mockUserRepo,
      },
    };
  });

  it('should soft delete an existing project', async () => {
    // Arrange
    const projectId = 'test-project-id';
    const existingProject: IProjectDocument = {
      id: projectId,
      name: 'Test Project',
      description: 'Test Description',
      userId,
      sessionIds: [],
      fileIds: [],
      systemPrompts: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (mockProjectRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingProject);
    (mockProjectRepo.update as Mock).mockResolvedValueOnce({
      ...existingProject,
      deletedAt: expect.any(Date),
    });

    // Act
    const result = await deleteProject(userId, { id: projectId }, adapters);

    // Assert
    expect(result.deletedAt).toBeInstanceOf(Date);
    expect(mockProjectRepo.findByIdAndUserId).toHaveBeenCalledWith(projectId, userId);
    expect(mockProjectRepo.update).toHaveBeenCalledWith({
      ...existingProject,
      deletedAt: expect.any(Date),
    });
  });

  it('should throw NotFoundError when project does not exist', async () => {
    // Arrange
    const projectId = 'non-existent-project-id';
    (mockProjectRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    // Act & Assert
    await expect(deleteProject(userId, { id: projectId }, adapters)).rejects.toThrow(NotFoundError);

    expect(mockProjectRepo.findByIdAndUserId).toHaveBeenCalledWith(projectId, userId);
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
  });

  it('should throw validation error for invalid project id', async () => {
    // Arrange
    const invalidParams = {
      id: '', // Invalid: empty string
    };

    // Act & Assert
    await expect(deleteProject(userId, invalidParams, adapters)).rejects.toThrow();

    expect(mockProjectRepo.findByIdAndUserId).toHaveBeenCalledWith('', userId);
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
  });

  describe('cascade grant removal', () => {
    it('strips a former members project-derived grant from the projects files and sessions', async () => {
      const projectId = 'test-project-id';
      const memberId = 'member-456';
      const fileId = 'file-001';
      const sessionId = 'session-001';

      const project: IProjectDocument = {
        id: projectId,
        name: 'Test Project',
        description: 'Test Description',
        userId,
        sessionIds: [sessionId],
        fileIds: [fileId],
        systemPrompts: [],
        isGlobalRead: false,
        isGlobalWrite: false,
        users: [{ userId: memberId, permissions: ['read'], projectId }],
        groups: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const file = {
        id: fileId,
        userId,
        users: [{ userId: memberId, permissions: ['read'], projectId }],
      };
      const session = {
        id: sessionId,
        userId,
        users: [{ userId: memberId, permissions: ['read'], projectId }],
      };

      (mockProjectRepo.findByIdAndUserId as Mock).mockResolvedValue(project);
      (mockProjectRepo.update as Mock).mockResolvedValue(project);
      (mockFabFileRepo.findAllByIds as Mock).mockResolvedValue([file]);
      (mockSessionRepo.findAllByIds as Mock).mockResolvedValue([session]);
      (mockUserRepo.findById as Mock).mockResolvedValue({ id: memberId });
      (mockFabFileRepo.shareable.findAccessibleById as Mock).mockResolvedValue(file);
      (mockSessionRepo.shareable.findAccessibleById as Mock).mockResolvedValue(session);

      await deleteProject(userId, { id: projectId }, adapters);

      expect(mockFabFileRepo.update).toHaveBeenCalledWith(expect.objectContaining({ users: [] }));
      expect(mockSessionRepo.update).toHaveBeenCalledWith(expect.objectContaining({ users: [] }));
    });

    // The cascade is not transactional and runs before deletedAt is set, so a member it cannot
    // resolve must not abort the loop: the project would be left undeletable on every retry,
    // deterministically, with the earlier members' file writes already persisted.
    it('still deletes the project when one members cascade cannot resolve', async () => {
      const projectId = 'test-project-id';
      const reachableId = 'member-reachable';
      const unreachableId = 'member-unreachable';
      const fileId = 'file-001';

      const project: IProjectDocument = {
        id: projectId,
        name: 'Test Project',
        description: 'Test Description',
        userId,
        sessionIds: [],
        fileIds: [fileId],
        systemPrompts: [],
        isGlobalRead: false,
        isGlobalWrite: false,
        users: [
          { userId: unreachableId, permissions: ['update'], projectId },
          { userId: reachableId, permissions: ['read'], projectId },
        ],
        groups: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as IProjectDocument;

      const file = {
        id: fileId,
        userId,
        users: [
          { userId: unreachableId, permissions: ['update'], projectId },
          { userId: reachableId, permissions: ['read'], projectId },
        ],
      };

      (mockProjectRepo.findByIdAndUserId as Mock).mockResolvedValue(project);
      (mockProjectRepo.update as Mock).mockResolvedValue(project);
      (mockFabFileRepo.findAllByIds as Mock).mockResolvedValue([file]);
      (mockSessionRepo.findAllByIds as Mock).mockResolvedValue([]);
      (mockSessionRepo.shareable.findAccessibleById as Mock).mockResolvedValue(null);
      // The update-only member is invisible to the read-level predicate the cascade resolves
      // through, so their leg throws NotFoundError; the read member's leg resolves normally.
      (mockUserRepo.findById as Mock).mockImplementation(async (id: string) => ({ id }));
      (mockFabFileRepo.shareable.findAccessibleById as Mock).mockImplementation(async (member: { id: string }) =>
        member.id === unreachableId ? null : file
      );

      const result = await deleteProject(userId, { id: projectId }, adapters);

      expect(result.deletedAt).toBeInstanceOf(Date);
      expect(mockProjectRepo.update).toHaveBeenCalled();
    });
  });
});
