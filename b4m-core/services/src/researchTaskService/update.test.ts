import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { update } from './update';
import { IResearchTask, ResearchTaskType } from '@bike4mind/common';
import { IUserDocument } from '@bike4mind/common';
import { mockResearchTask } from '../__tests__/utils/testUtils';

describe('researchTaskService - update', () => {
  const mockUser = {
    id: 'test-user-123',
    email: 'test@example.com',
    name: 'Test User',
    username: 'testuser',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IUserDocument;

  let mockResearchTaskRepo: any;
  let adapters: any;

  beforeEach(() => {
    mockResearchTaskRepo = {
      findByIdAndUserId: vi.fn(),
      update: vi.fn(),
    };
    adapters = {
      db: {
        researchTasks: mockResearchTaskRepo,
      },
    };
  });

  it('should update a research task', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const existingTask: IResearchTask = mockResearchTask({
      id: taskId,
      title: 'Original Title',
      description: 'Original Description',
    });

    const updateParams = {
      id: taskId,
      title: 'Updated Title',
      description: 'Updated Description',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://updated.com'],
      canDiscoverLinks: true,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingTask);
    (mockResearchTaskRepo.update as Mock).mockResolvedValueOnce({
      ...existingTask,
      ...updateParams,
    });

    // Act
    const result = await update(mockUser, updateParams, adapters);

    // Assert
    expect(result).toEqual({
      ...existingTask,
      ...updateParams,
    });
    expect(mockResearchTaskRepo.findByIdAndUserId).toHaveBeenCalledWith(taskId, mockUser.id);
  });

  it('should update a SCRAPE-type research task with url and canDiscoverLinks', async () => {
    // Arrange
    const taskId = 'scrape-task-id';
    const existingTask: IResearchTask = mockResearchTask({
      id: taskId,
      title: 'Original Title',
      description: 'Original Description',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://original.com'],
      canDiscoverLinks: false,
    });

    const updateParams = {
      id: taskId,
      title: 'Updated Title',
      description: 'Updated Description',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://updated.com'],
      canDiscoverLinks: true,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingTask);
    (mockResearchTaskRepo.update as Mock).mockResolvedValueOnce({
      ...existingTask,
      ...updateParams,
    });

    // Act
    const result = await update(mockUser, updateParams, adapters);

    // Assert
    expect(result).toEqual({
      ...existingTask,
      ...updateParams,
    });
    expect(mockResearchTaskRepo.findByIdAndUserId).toHaveBeenCalledWith(taskId, mockUser.id);
    expect(mockResearchTaskRepo.update).toHaveBeenCalledWith({
      ...existingTask,
      ...updateParams,
    });
  });

  it('should throw error when research task is not found', async () => {
    // Arrange
    const taskId = 'non-existent-task';
    const updateParams = {
      id: taskId,
      title: 'Updated Title',
      description: 'Updated Description',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://updated.com'],
      canDiscoverLinks: true,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    // Act & Assert
    await expect(update(mockUser, updateParams, adapters)).rejects.toThrow('Research task not found');
    expect(mockResearchTaskRepo.update).not.toHaveBeenCalled();
  });

  it('should handle multiple URLs for SCRAPE-type research task', async () => {
    // Arrange
    const taskId = 'multi-url-task-id';
    const existingTask: IResearchTask = mockResearchTask({
      id: taskId,
      title: 'Original Title',
      description: 'Original Description',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://original.com'],
      canDiscoverLinks: false,
    });

    const updateParams = {
      id: taskId,
      title: 'Updated Title',
      description: 'Updated Description',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://updated.com', 'https://another.com', 'https://third.com'],
      canDiscoverLinks: true,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingTask);
    (mockResearchTaskRepo.update as Mock).mockResolvedValueOnce({
      ...existingTask,
      ...updateParams,
    });

    // Act
    const result = await update(mockUser, updateParams, adapters);

    // Assert
    expect(result).toEqual({
      ...existingTask,
      ...updateParams,
    });
    expect(result.type).toBe(ResearchTaskType.SCRAPE);
    if (result.type === ResearchTaskType.SCRAPE) {
      expect(result.urls).toHaveLength(3);
      expect(result.urls).toContain('https://updated.com');
      expect(result.urls).toContain('https://another.com');
      expect(result.urls).toContain('https://third.com');
    }
  });

  it('should throw validation error for invalid parameters', async () => {
    // Arrange
    const invalidParams = {
      id: '', // Invalid: empty string
      title: '', // Invalid: empty string
      description: '', // Invalid: empty string
      type: ResearchTaskType.SCRAPE,
      urls: ['https://updated.com'],
      canDiscoverLinks: true,
    };

    // Act & Assert
    await expect(update(mockUser, invalidParams, adapters)).rejects.toThrow();
    expect(mockResearchTaskRepo.update).not.toHaveBeenCalled();
  });
});
