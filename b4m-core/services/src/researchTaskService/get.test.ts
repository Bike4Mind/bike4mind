import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { get } from './get';
import { IResearchTask, IResearchData } from '@bike4mind/common';
import { IUserDocument } from '@bike4mind/common';
import { mockResearchTask } from '../__tests__/utils/testUtils';

describe('researchTaskService - get', () => {
  const mockUser = {
    id: 'test-user-123',
    email: 'test@example.com',
    name: 'Test User',
    username: 'testuser',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IUserDocument;

  let mockResearchTaskRepo: any;
  let mockResearchDataRepo: any;
  let adapters: any;

  beforeEach(() => {
    mockResearchTaskRepo = {
      findByIdAndUserId: vi.fn(),
    };
    mockResearchDataRepo = {
      findAllByResearchTaskIdWithFiles: vi.fn(),
    };
    adapters = {
      db: {
        researchTasks: mockResearchTaskRepo,
        researchData: mockResearchDataRepo,
      },
    };
  });

  it('should get a research task by id', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const expectedTask: IResearchTask = mockResearchTask({
      id: taskId,
    });

    const mockResearchData: IResearchData[] = [
      {
        id: 'research-data-1',
        fabFileId: 'fab-file-1',
        researchAgentId: expectedTask.researchAgentId,
        researchTaskId: taskId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(expectedTask);
    (mockResearchDataRepo.findAllByResearchTaskIdWithFiles as Mock).mockResolvedValueOnce(mockResearchData);

    // Act
    const result = await get(mockUser, { id: taskId }, adapters);

    // Assert
    expect(result).toEqual({
      ...expectedTask,
      researchData: mockResearchData,
    });
    expect(mockResearchTaskRepo.findByIdAndUserId).toHaveBeenCalledWith(taskId, mockUser.id);
    expect(mockResearchDataRepo.findAllByResearchTaskIdWithFiles).toHaveBeenCalledWith(taskId);
  });

  it('should throw error when research task is not found', async () => {
    // Arrange
    const taskId = 'non-existent-task';
    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    // Act & Assert
    await expect(get(mockUser, { id: taskId }, adapters)).rejects.toThrow('Research task not found');
  });

  it('should throw validation error for invalid parameters', async () => {
    // Arrange
    const invalidParams = {
      id: '', // Invalid: empty string
    };

    // Act & Assert
    await expect(get(mockUser, invalidParams, adapters)).rejects.toThrow();
  });
});
