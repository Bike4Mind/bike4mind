import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import {
  ResearchTaskStatus,
  ResearchTaskType,
  IResearchTaskScrape,
  ResearchTaskExecutionType,
} from '@bike4mind/common';
import { researchTaskRepository } from './ResearchTaskModel';
import { setupMongoTest } from '../../__test__/utils';

describe('ResearchTaskRepository', () => {
  const userId = new mongoose.Types.ObjectId().toString();
  const researchAgentId = new mongoose.Types.ObjectId().toString();

  setupMongoTest();

  function byCreatedAtDesc(a: { createdAt: Date }, b: { createdAt: Date }) {
    return b.createdAt.getTime() - a.createdAt.getTime();
  }

  describe('findByIdAndUserId', () => {
    it('should find task by id and userId', async () => {
      // Arrange
      const taskData: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
        userId,
        researchAgentId,
        title: 'Test Task',
        description: 'Test Description',
        type: ResearchTaskType.SCRAPE,
        status: ResearchTaskStatus.PENDING,
        url: 'https://example.com',
        canDiscoverLinks: true,
        executionType: ResearchTaskExecutionType.ON_DEMAND,
        urls: ['https://example.com'],
        discoveredLinks: [],
      };
      const task = await researchTaskRepository.create(taskData);

      // Act
      const result = await researchTaskRepository.findByIdAndUserId(task.id, userId);

      // Assert
      expect(result).toMatchObject({
        ...taskData,
        id: task.id,
      });
    });

    it('should return null when task not found by id and userId', async () => {
      // Arrange
      const nonExistentId = new mongoose.Types.ObjectId().toString();

      // Act
      const result = await researchTaskRepository.findByIdAndUserId(nonExistentId, userId);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when task belongs to different user', async () => {
      // Arrange
      const otherUserId = new mongoose.Types.ObjectId().toString();
      const taskData: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: otherUserId,
        researchAgentId,
        title: 'Test Task',
        description: 'Test Description',
        type: ResearchTaskType.SCRAPE,
        status: ResearchTaskStatus.PENDING,
        url: 'https://example.com',
        canDiscoverLinks: true,
        executionType: ResearchTaskExecutionType.ON_DEMAND,
        urls: ['https://example.com'],
        discoveredLinks: [],
      };
      const task = await researchTaskRepository.create(taskData);

      // Act
      const result = await researchTaskRepository.findByIdAndUserId(task.id, userId);

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('findAllByUserId', () => {
    it('should find all tasks by userId', async () => {
      // Arrange
      const taskData1: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
        userId,
        researchAgentId,
        title: 'Test Task 1',
        description: 'Test Description 1',
        type: ResearchTaskType.SCRAPE,
        status: ResearchTaskStatus.PENDING,
        url: 'https://example1.com',
        canDiscoverLinks: true,
        executionType: ResearchTaskExecutionType.ON_DEMAND,
        urls: [`https://example1.com`],

        discoveredLinks: [],
      };
      const taskData2: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
        userId,
        researchAgentId,
        title: 'Test Task 2',
        description: 'Test Description 2',
        type: ResearchTaskType.SCRAPE,
        status: ResearchTaskStatus.PENDING,
        url: 'https://example2.com',
        canDiscoverLinks: true,
        executionType: ResearchTaskExecutionType.ON_DEMAND,
        urls: [`https://example1.com`],

        discoveredLinks: [],
      };

      await researchTaskRepository.create(taskData1);
      await researchTaskRepository.create(taskData2);

      // Act
      const results = await researchTaskRepository.findAllByUserId(userId);

      // Assert
      expect(results).toHaveLength(2);
      // Order is not guaranteed; assert set membership instead.
      const titles = results.map(r => r.title);
      expect(titles).toEqual(expect.arrayContaining([taskData1.title, taskData2.title]));
      const urls = results.map(r => ('url' in (r as object) ? (r as unknown as { url?: string }).url : undefined));
      expect(urls).toEqual(expect.arrayContaining([taskData1.url, taskData2.url]));
    });

    it('should return empty array when user has no tasks', async () => {
      // Arrange
      const newUserId = new mongoose.Types.ObjectId().toString();

      // Act
      const results = await researchTaskRepository.findAllByUserId(newUserId);

      // Assert
      expect(results).toHaveLength(0);
    });

    it('should only return tasks for specified user', async () => {
      // Arrange
      const otherUserId = new mongoose.Types.ObjectId().toString();
      const taskData: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: otherUserId,
        researchAgentId,
        title: 'Other User Task',
        description: 'Other User Description',
        type: ResearchTaskType.SCRAPE,
        status: ResearchTaskStatus.PENDING,
        url: 'https://example.com',
        canDiscoverLinks: true,
        executionType: ResearchTaskExecutionType.ON_DEMAND,
        urls: [`https://example1.com`],
        discoveredLinks: [],
      };
      await researchTaskRepository.create(taskData);

      // Act
      const results = await researchTaskRepository.findAllByUserId(userId);

      // Assert
      expect(results).toHaveLength(0);
      expect(results.every(task => task.userId === userId)).toBe(true);
    });
  });

  describe('search', () => {
    it('should search tasks with pagination and ordering', async () => {
      // Arrange
      await Promise.all(
        Array.from({ length: 15 }, (_, i) => {
          const taskData: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
            userId,
            researchAgentId,
            // Use unique titles/descriptions to avoid accidental ordering ties in some DB implementations.
            title: `Test Task ${i + 1}`,
            description: `Test Description ${i + 1}`,
            type: ResearchTaskType.SCRAPE,
            status: ResearchTaskStatus.PENDING,
            url: `https://example1.com`,
            canDiscoverLinks: true,
            executionType: ResearchTaskExecutionType.ON_DEMAND,
            urls: [`https://example1.com`],
            discoveredLinks: [],
          };
          return researchTaskRepository.create(taskData);
        })
      );

      // Act
      const result = await researchTaskRepository.search(
        '',
        { userId },
        { page: 1, limit: 10 },
        { by: 'createdAt', direction: 'desc' }
      );

      // Assert
      expect(result.data).toHaveLength(10);
      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(15);
      // createdAt can be equal at ms precision; assert non-increasing instead of strictly greater.
      const sorted = [...result.data].sort(byCreatedAtDesc);
      expect(result.data.map(d => d.id)).toEqual(sorted.map(d => d.id));
    });

    it('should search tasks with text search', async () => {
      // Arrange
      const tasks: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'>[] = [
        {
          userId,
          researchAgentId,
          title: 'Specific Task Name',
          description: 'Test Description',
          type: ResearchTaskType.SCRAPE,
          status: ResearchTaskStatus.PENDING,
          url: 'https://example.com',
          canDiscoverLinks: true,
          executionType: ResearchTaskExecutionType.ON_DEMAND,
          urls: [`https://example1.com`],
          discoveredLinks: [],
        },
        {
          userId,
          researchAgentId,
          title: 'Another Task',
          description: 'Different Description',
          type: ResearchTaskType.SCRAPE,
          status: ResearchTaskStatus.PENDING,
          url: 'https://example.com',
          canDiscoverLinks: true,
          executionType: ResearchTaskExecutionType.ON_DEMAND,
          urls: [`https://example1.com`],
          discoveredLinks: [],
        },
      ];

      await Promise.all(tasks.map(task => researchTaskRepository.create(task)));

      // Act
      const result = await researchTaskRepository.search(
        'Specific',
        { userId },
        { page: 1, limit: 10 },
        { by: 'createdAt', direction: 'desc' }
      );

      // Assert
      expect(result.data).toHaveLength(1);
      expect(result.data[0].title).toBe('Specific Task Name');
      expect(result.total).toBe(1);
    });

    it('should search tasks with multiple pages', async () => {
      // Arrange
      await Promise.all(
        Array.from({ length: 15 }, (_, i) => {
          const taskData: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
            userId,
            researchAgentId,
            title: `Test Task ${i + 1}`,
            description: `Test Description ${i + 1}`,
            type: ResearchTaskType.SCRAPE,
            status: ResearchTaskStatus.PENDING,
            url: `https://example1.com`,
            canDiscoverLinks: true,
            executionType: ResearchTaskExecutionType.ON_DEMAND,
            urls: [`https://example1.com`],
            discoveredLinks: [],
          };
          return researchTaskRepository.create(taskData);
        })
      );

      // Act
      const page1 = await researchTaskRepository.search(
        '',
        { userId },
        { page: 1, limit: 10 },
        { by: 'createdAt', direction: 'desc' }
      );

      const page2 = await researchTaskRepository.search(
        '',
        { userId },
        { page: 2, limit: 10 },
        { by: 'createdAt', direction: 'desc' }
      );

      // Assert
      expect(page1.data).toHaveLength(10);
      expect(page2.data).toHaveLength(5);
      expect(page1.hasMore).toBe(true);
      expect(page2.hasMore).toBe(false);
      expect(page1.total).toBe(15);
      expect(page2.total).toBe(15);
    });
  });

  describe('updateManyByResearchAgentId', () => {
    it('should update all tasks associated with a research agent', async () => {
      // Arrange
      const tasks = await Promise.all(
        Array.from({ length: 3 }, (_, i) => {
          const taskData: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
            userId,
            researchAgentId,
            title: `Test Task 1`,
            description: `Test Description 1`,
            type: ResearchTaskType.SCRAPE,
            status: ResearchTaskStatus.PENDING,
            url: `https://example1.com`,
            canDiscoverLinks: true,
            executionType: ResearchTaskExecutionType.ON_DEMAND,
            urls: [`https://example1.com`],
            discoveredLinks: [],
          };
          return researchTaskRepository.create(taskData);
        })
      );

      const updateData = {
        status: ResearchTaskStatus.COMPLETED,
        title: 'Updated Task Title',
      };

      // Act
      await researchTaskRepository.updateManyByResearchAgentId(researchAgentId, updateData);

      // Force refresh from database
      const updatedTasks = await Promise.all(
        tasks.map(task => researchTaskRepository.findByIdAndUserId(task.id, userId))
      );

      // Assert
      updatedTasks.forEach(task => {
        expect(task).not.toBeNull();
        if (!task) return; // TypeScript null check
        expect(task.status).toBe(ResearchTaskStatus.COMPLETED);
        expect(task.title).toBe('Updated Task Title');
        expect(task.updatedAt).toBeInstanceOf(Date);
        // Ensure updatedAt is more recent than the original creation
        expect(task.updatedAt.getTime()).toBeGreaterThan(task.createdAt.getTime());
      });
    });

    it('should only update tasks for the specified research agent', async () => {
      // Arrange
      const otherResearchAgentId = new mongoose.Types.ObjectId().toString();

      // Create tasks for both research agents
      const targetAgentTasks = await Promise.all(
        Array.from({ length: 2 }, (_, i) => {
          const taskData: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
            userId,
            researchAgentId,
            title: `Target Agent Task 1`,
            description: `Test Description 1`,
            type: ResearchTaskType.SCRAPE,
            status: ResearchTaskStatus.PENDING,
            url: `https://example1.com`,
            canDiscoverLinks: true,
            executionType: ResearchTaskExecutionType.ON_DEMAND,
            urls: [`https://example1.com`],
            discoveredLinks: [],
          };
          return researchTaskRepository.create(taskData);
        })
      );

      const otherAgentTasks = await Promise.all(
        Array.from({ length: 2 }, (_, i) => {
          const taskData: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
            userId,
            researchAgentId: otherResearchAgentId,
            title: `Other Agent Task 1`,
            description: `Test Description 1`,
            type: ResearchTaskType.SCRAPE,
            status: ResearchTaskStatus.PENDING,
            url: `https://example1.com`,
            canDiscoverLinks: true,
            executionType: ResearchTaskExecutionType.ON_DEMAND,
            urls: [`https://example1.com`],
            discoveredLinks: [],
          };
          return researchTaskRepository.create(taskData);
        })
      );

      const updateData = {
        status: ResearchTaskStatus.COMPLETED,
        description: 'Updated Description',
      };

      // Act
      await researchTaskRepository.updateManyByResearchAgentId(researchAgentId, updateData);

      // Force refresh from database
      const updatedTargetTasks = await Promise.all(
        targetAgentTasks.map(task => researchTaskRepository.findByIdAndUserId(task.id, userId))
      );

      const nonUpdatedTasks = await Promise.all(
        otherAgentTasks.map(task => researchTaskRepository.findByIdAndUserId(task.id, userId))
      );

      // Assert
      updatedTargetTasks.forEach(task => {
        expect(task).not.toBeNull();
        if (!task) return; // TypeScript null check
        expect(task.status).toBe(ResearchTaskStatus.COMPLETED);
        expect(task.description).toBe('Updated Description');
        expect(task.updatedAt).toBeInstanceOf(Date);
        expect(task.updatedAt.getTime()).toBeGreaterThan(task.createdAt.getTime());
      });

      nonUpdatedTasks.forEach(task => {
        expect(task?.status).toBe(ResearchTaskStatus.PENDING);
        expect(task?.description).toContain('Test Description');
      });
    });

    it('should handle update when no tasks exist for the research agent', async () => {
      // Arrange
      const nonExistentAgentId = new mongoose.Types.ObjectId().toString();
      const updateData = {
        status: ResearchTaskStatus.COMPLETED,
        title: 'Updated Title',
      };

      // Act & Assert
      await expect(
        researchTaskRepository.updateManyByResearchAgentId(nonExistentAgentId, updateData)
      ).resolves.not.toThrow();
    });
  });

  describe('findAllByUserIdAndResearchAgentId', () => {
    it('should find all tasks by userId and researchAgentId', async () => {
      // Arrange
      const taskData1: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
        userId,
        researchAgentId,
        title: 'Test Task 1',
        description: 'Test Description 1',
        type: ResearchTaskType.SCRAPE,
        status: ResearchTaskStatus.PENDING,
        url: 'https://example1.com',
        canDiscoverLinks: true,
        executionType: ResearchTaskExecutionType.ON_DEMAND,
        urls: [`https://example1.com`],

        discoveredLinks: [],
      };
      const taskData2: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
        userId,
        researchAgentId,
        title: 'Test Task 2',
        description: 'Test Description 2',
        type: ResearchTaskType.SCRAPE,
        status: ResearchTaskStatus.PENDING,
        url: 'https://example2.com',
        canDiscoverLinks: true,
        executionType: ResearchTaskExecutionType.ON_DEMAND,
        urls: [`https://example1.com`],

        discoveredLinks: [],
      };

      await researchTaskRepository.create(taskData1);
      await researchTaskRepository.create(taskData2);

      // Act
      const results = await researchTaskRepository.findAllByUserIdAndResearchAgentId(userId, researchAgentId);

      // Assert
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject(taskData1);
      expect(results[1]).toMatchObject(taskData2);
    });

    it('should return empty array when no tasks exist for user and research agent', async () => {
      // Arrange
      const newUserId = new mongoose.Types.ObjectId().toString();
      const newResearchAgentId = new mongoose.Types.ObjectId().toString();

      // Act
      const results = await researchTaskRepository.findAllByUserIdAndResearchAgentId(newUserId, newResearchAgentId);

      // Assert
      expect(results).toHaveLength(0);
    });

    it('should only return tasks for specified user and research agent', async () => {
      // Arrange
      const otherUserId = new mongoose.Types.ObjectId().toString();
      const otherResearchAgentId = new mongoose.Types.ObjectId().toString();
      const taskData: Omit<IResearchTaskScrape, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: otherUserId,
        researchAgentId: otherResearchAgentId,
        title: 'Other User Task',
        description: 'Other User Description',
        type: ResearchTaskType.SCRAPE,
        status: ResearchTaskStatus.PENDING,
        url: 'https://example.com',
        canDiscoverLinks: true,
        executionType: ResearchTaskExecutionType.ON_DEMAND,
        urls: [`https://example1.com`],
        discoveredLinks: [],
      };
      await researchTaskRepository.create(taskData);

      // Act
      const results = await researchTaskRepository.findAllByUserIdAndResearchAgentId(userId, researchAgentId);

      // Assert
      expect(results).toHaveLength(0);
    });
  });
});
