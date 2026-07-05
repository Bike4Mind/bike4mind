import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { search } from './search';
import { IResearchTask } from '@bike4mind/common';
import { IUserDocument } from '@bike4mind/common';
import { mockResearchTask } from '../__tests__/utils/testUtils';

describe('researchTaskService - search', () => {
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
      search: vi.fn(),
    };
    adapters = {
      db: {
        researchTasks: mockResearchTaskRepo,
      },
    };
  });

  it('should search research tasks with default parameters', async () => {
    // Arrange
    const mockTasks: IResearchTask[] = [mockResearchTask({ id: 'task-1' }), mockResearchTask({ id: 'task-2' })];

    (mockResearchTaskRepo.search as Mock).mockResolvedValueOnce(mockTasks);

    // Act
    const result = await search(mockUser, {}, adapters);

    // Assert
    expect(result).toEqual(mockTasks);
    expect(mockResearchTaskRepo.search).toHaveBeenCalledWith(
      '',
      { userId: mockUser.id },
      { page: 1, limit: 10 },
      { by: 'createdAt', direction: 'desc' }
    );
  });

  it('should search research tasks with custom search term', async () => {
    // Arrange
    const searchTerm = 'test search';
    const mockTasks: IResearchTask[] = [mockResearchTask({ id: 'task-1' }), mockResearchTask({ id: 'task-2' })];

    (mockResearchTaskRepo.search as Mock).mockResolvedValueOnce(mockTasks);

    // Act
    const result = await search(mockUser, { search: searchTerm }, adapters);

    // Assert
    expect(result).toEqual(mockTasks);
    expect(mockResearchTaskRepo.search).toHaveBeenCalledWith(
      searchTerm,
      { userId: mockUser.id },
      { page: 1, limit: 10 },
      { by: 'createdAt', direction: 'desc' }
    );
  });

  it('should search research tasks with custom pagination', async () => {
    // Arrange
    const pagination = {
      page: 2,
      limit: 20,
    };

    const mockTasks: IResearchTask[] = [mockResearchTask({ id: 'task-1' })];

    (mockResearchTaskRepo.search as Mock).mockResolvedValueOnce(mockTasks);

    // Act
    const result = await search(mockUser, { pagination }, adapters);

    // Assert
    expect(result).toEqual(mockTasks);
    expect(mockResearchTaskRepo.search).toHaveBeenCalledWith('', { userId: mockUser.id }, pagination, {
      by: 'createdAt',
      direction: 'desc',
    });
  });

  it('should search research tasks with custom ordering', async () => {
    // Arrange
    const orderBy = {
      by: 'updatedAt' as const,
      direction: 'asc' as const,
    };

    const mockTasks: IResearchTask[] = [mockResearchTask({ id: 'task-1' })];

    (mockResearchTaskRepo.search as Mock).mockResolvedValueOnce(mockTasks);

    // Act
    const result = await search(mockUser, { orderBy }, adapters);

    // Assert
    expect(result).toEqual(mockTasks);
    expect(mockResearchTaskRepo.search).toHaveBeenCalledWith(
      '',
      { userId: mockUser.id },
      { page: 1, limit: 10 },
      orderBy
    );
  });

  it('should search research tasks with all custom parameters', async () => {
    // Arrange
    const searchParams = {
      search: 'test search',
      pagination: {
        page: 2,
        limit: 20,
      },
      orderBy: {
        by: 'updatedAt' as const,
        direction: 'asc' as const,
      },
    };

    const mockTasks: IResearchTask[] = [mockResearchTask({ id: 'task-1' })];

    (mockResearchTaskRepo.search as Mock).mockResolvedValueOnce(mockTasks);

    // Act
    const result = await search(mockUser, searchParams, adapters);

    // Assert
    expect(result).toEqual(mockTasks);
    expect(mockResearchTaskRepo.search).toHaveBeenCalledWith(
      searchParams.search,
      { userId: mockUser.id },
      searchParams.pagination,
      searchParams.orderBy
    );
  });
});
