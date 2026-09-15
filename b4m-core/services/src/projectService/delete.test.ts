import { describe, it, expect, beforeEach, Mock } from 'vitest';
import { deleteProject } from './delete';
import { createMockProjectRepository } from '../__tests__/utils/testUtils';
import { IProjectDocument, IProjectRepository } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

describe('projectService - delete', () => {
  const userId = 'test-user-123';
  let mockProjectRepo: IProjectRepository;
  let adapters: { db: { projects: IProjectRepository } };

  beforeEach(() => {
    mockProjectRepo = createMockProjectRepository();
    adapters = {
      db: {
        projects: mockProjectRepo,
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
});
