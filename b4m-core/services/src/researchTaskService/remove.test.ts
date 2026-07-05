import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { remove } from './remove';
import { IUserDocument } from '@bike4mind/common';
import { IResearchDataRepository, IResearchTaskRepository } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { mockResearchTask } from '../__tests__/utils/testUtils';

describe('researchTaskService - remove', () => {
  const mockUser = {
    id: 'test-user-456',
    email: 'remove@example.com',
    name: 'Remove User',
  } as IUserDocument;

  const taskId = 'task-to-remove-123';

  let mockResearchTaskRepo: {
    findByIdAndUserId: Mock;
    update: Mock;
  };
  let mockResearchDataRepo: {
    deleteAllByResearchTaskId: Mock;
  };
  let adapters: {
    db: {
      researchTasks: IResearchTaskRepository;
      researchDatas: IResearchDataRepository;
    };
  };

  beforeEach(() => {
    mockResearchTaskRepo = {
      findByIdAndUserId: vi.fn(),
      update: vi.fn(),
    };
    mockResearchDataRepo = {
      deleteAllByResearchTaskId: vi.fn(),
    };
    adapters = {
      db: {
        researchTasks: mockResearchTaskRepo as unknown as IResearchTaskRepository,
        researchDatas: mockResearchDataRepo as unknown as IResearchDataRepository,
      },
    };
  });

  it('should successfully mark a research task as deleted', async () => {
    // Arrange
    const params = { id: taskId };
    const existingTask = mockResearchTask({ id: taskId, userId: mockUser.id });
    mockResearchTaskRepo.findByIdAndUserId.mockResolvedValueOnce(existingTask);
    mockResearchTaskRepo.update.mockResolvedValueOnce({ ...existingTask, deletedAt: new Date() }); // Simulate update result

    // Act
    const result = await remove(mockUser, params, adapters);

    // Assert
    expect(mockResearchTaskRepo.findByIdAndUserId).toHaveBeenCalledWith(taskId, mockUser.id);
    expect(mockResearchTaskRepo.update).toHaveBeenCalledOnce();
    const updatedTask = mockResearchTaskRepo.update.mock.calls[0][0];
    expect(updatedTask.id).toBe(taskId);
    expect(updatedTask.deletedAt).toBeInstanceOf(Date);
    expect(result).toEqual(updatedTask); // Check if the returned task has deletedAt set
  });

  it('should throw NotFoundError if the research task is not found', async () => {
    // Arrange
    const params = { id: 'non-existent-task-id' };
    mockResearchTaskRepo.findByIdAndUserId.mockResolvedValueOnce(null);

    // Act & Assert
    await expect(remove(mockUser, params, adapters)).rejects.toThrow(NotFoundError);
    await expect(remove(mockUser, params, adapters)).rejects.toThrow('Research task not found');
    expect(mockResearchTaskRepo.findByIdAndUserId).toHaveBeenCalledWith('non-existent-task-id', mockUser.id);
    expect(mockResearchTaskRepo.update).not.toHaveBeenCalled();
  });

  it('should throw NotFoundError if the research task belongs to another user', async () => {
    // Arrange
    const params = { id: taskId };
    // Simulate findByIdAndUserId returning null because the userId doesn't match
    mockResearchTaskRepo.findByIdAndUserId.mockResolvedValueOnce(null);

    // Act & Assert
    await expect(remove(mockUser, params, adapters)).rejects.toThrow(NotFoundError);
    expect(mockResearchTaskRepo.findByIdAndUserId).toHaveBeenCalledWith(taskId, mockUser.id);
    expect(mockResearchTaskRepo.update).not.toHaveBeenCalled();
  });

  it('should throw a validation error for invalid parameters', async () => {
    // Arrange
    const invalidParams = { id: '' }; // Invalid: empty string

    // Act & Assert
    // secureParameters throws an error before the function body executes fully
    await expect(remove(mockUser, invalidParams, adapters)).rejects.toThrow();
    expect(mockResearchTaskRepo.findByIdAndUserId).not.toHaveBeenCalled();
    expect(mockResearchTaskRepo.update).not.toHaveBeenCalled();
  });
});
