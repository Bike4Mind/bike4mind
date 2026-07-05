import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { create } from './create';
import {
  IResearchTask,
  ResearchTaskType,
  ResearchTaskExecutionType,
  ResearchTaskStatus,
  TaskScheduleHandler,
  ResearchTaskPeriodicFrequencyType,
} from '@bike4mind/common';
import { IUserDocument } from '@bike4mind/common';
import { taskSchedulerService } from '..';
import { mockResearchAgent, mockResearchTask } from '../__tests__/utils/testUtils';

describe('researchTaskService - create', () => {
  const mockUser = {
    id: 'test-user-123',
    email: 'test@example.com',
    name: 'Test User',
  } as IUserDocument;

  let mockAgent: any;
  let mockResearchTaskRepo: any;
  let mockResearchAgentRepo: any;
  let mockProcess: Mock;
  let mockLogger: { info: Mock; error: Mock };
  let mockTaskSchedulerCreate: Mock;
  let adapters: any;

  beforeEach(() => {
    mockAgent = mockResearchAgent();
    mockResearchTaskRepo = {
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      findByIdAndUserId: vi.fn(),
    };

    mockResearchAgentRepo = {
      findByIdAndUserId: vi.fn(),
    };

    mockProcess = vi.fn();
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    mockTaskSchedulerCreate = vi.fn();
    vi.spyOn(taskSchedulerService, 'create').mockImplementation(mockTaskSchedulerCreate);
    adapters = {
      db: {
        transaction: async <T>(fn: () => Promise<T>) => fn(),
        researchTasks: mockResearchTaskRepo,
        researchAgents: {
          findByIdAndUserId: vi.fn().mockResolvedValue(mockAgent),
        },
      },
      jobs: {
        researchTasks: {
          process: mockProcess,
        },
      },
      logger: mockLogger,
    };
  });

  it('should create a scrape research task', async () => {
    // Arrange
    const params = {
      title: 'Test Research Task',
      description: 'Test Description',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://example.com'],
      canDiscoverLinks: true,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    const expectedTask: IResearchTask = mockResearchTask({
      userId: mockUser.id,
      title: params.title,
      description: params.description,
      researchAgentId: params.researchAgentId,
      urls: params.urls,
      canDiscoverLinks: params.canDiscoverLinks,
      executionType: params.executionType,
    });

    (mockResearchTaskRepo.create as Mock).mockResolvedValueOnce(expectedTask);

    // Act
    const result = await create(mockUser, params, adapters);

    // Assert
    expect(result).toEqual(expectedTask);
    expect(mockResearchTaskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mockUser.id,
        title: params.title,
        description: params.description,
        researchAgentId: params.researchAgentId,
        urls: params.urls,
        canDiscoverLinks: params.canDiscoverLinks,
        executionType: params.executionType,
        type: ResearchTaskType.SCRAPE,
        status: ResearchTaskStatus.PENDING,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      })
    );
    expect(mockProcess).toHaveBeenCalledWith(expectedTask.id, mockUser.id);
    expect(mockLogger.info).toHaveBeenCalledWith(`Creating research task ${params.title}`);
    expect(mockLogger.info).toHaveBeenCalledWith(`Processing research task ${expectedTask.id}`);
  });

  it('should create a scrape research task with multiple URLs', async () => {
    // Arrange
    const params = {
      title: 'Multi-URL Research Task',
      description: 'Test Description for multiple URLs',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://example.com', 'https://test.com', 'https://demo.com'],
      canDiscoverLinks: true,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    const expectedTask: IResearchTask = mockResearchTask({
      userId: mockUser.id,
      title: params.title,
      description: params.description,
      researchAgentId: params.researchAgentId,
      urls: params.urls,
      canDiscoverLinks: params.canDiscoverLinks,
      executionType: params.executionType,
    });

    (mockResearchTaskRepo.create as Mock).mockResolvedValueOnce(expectedTask);

    // Act
    const result = await create(mockUser, params, adapters);

    // Assert
    expect(result).toEqual(expectedTask);
    expect((result as any).urls).toHaveLength(3);
    expect((result as any).urls).toEqual(['https://example.com', 'https://test.com', 'https://demo.com']);
    expect(mockResearchTaskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mockUser.id,
        title: params.title,
        description: params.description,
        researchAgentId: params.researchAgentId,
        urls: params.urls,
        canDiscoverLinks: params.canDiscoverLinks,
        executionType: params.executionType,
        type: ResearchTaskType.SCRAPE,
        status: ResearchTaskStatus.PENDING,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      })
    );
    expect(mockProcess).toHaveBeenCalledWith(expectedTask.id, mockUser.id);
  });

  it('should handle process failure gracefully', async () => {
    // Arrange
    const params = {
      title: 'Test Research Task',
      description: 'Test Description',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://example.com'],
      canDiscoverLinks: true,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    const expectedTask: IResearchTask = mockResearchTask({
      id: 'test-task-id',
      researchAgentId: 'test-research-agent-id',
      title: params.title,
      description: params.description,
      type: ResearchTaskType.SCRAPE,
    });

    (mockResearchTaskRepo.create as Mock).mockResolvedValueOnce(expectedTask);
    mockProcess.mockRejectedValueOnce(new Error('Process failed'));

    // Act
    const result = await create(mockUser, params, adapters);

    // Assert
    expect(result).toEqual(expectedTask);
    expect(mockLogger.error).toHaveBeenCalledWith(
      `Failed to process research task ${expectedTask.id}: Error: Process failed`
    );
  });

  it('should throw validation error for invalid parameters', async () => {
    // Arrange
    const invalidParams = {
      title: '', // Invalid: empty string
      description: '', // Invalid: empty string
      type: ResearchTaskType.SCRAPE,
      urls: ['https://example.com'],
      canDiscoverLinks: true,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    // Act & Assert
    await expect(create(mockUser, invalidParams, adapters)).rejects.toThrow();
  });

  it('should throw validation error for title exceeding 100 characters', async () => {
    // Arrange
    const longTitle = 'a'.repeat(101); // 101 characters - exceeds limit
    const invalidParams = {
      title: longTitle,
      description: 'Valid description',
      type: ResearchTaskType.SCRAPE,
      url: 'https://example.com',
      canDiscoverLinks: true,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    // Act & Assert
    await expect(create(mockUser, invalidParams, adapters)).rejects.toThrow();
  });

  it('should accept title with exactly 100 characters', async () => {
    // Arrange
    const exactLengthTitle = 'a'.repeat(100); // Exactly 100 characters
    const params = {
      title: exactLengthTitle,
      description: 'Valid description',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://example.com'],
      canDiscoverLinks: true,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    const expectedTask: IResearchTask = mockResearchTask({
      userId: mockUser.id,
      title: params.title,
      description: params.description,
      researchAgentId: params.researchAgentId,
      urls: params.urls,
      canDiscoverLinks: params.canDiscoverLinks,
      executionType: params.executionType,
    });

    (mockResearchTaskRepo.create as Mock).mockResolvedValueOnce(expectedTask);

    // Act
    const result = await create(mockUser, params, adapters);

    // Assert
    expect(result).toEqual(expectedTask);
    expect(result.title).toBe(exactLengthTitle);
  });

  it('should throw validation error for description exceeding 500 characters', async () => {
    // Arrange
    const longDescription = 'a'.repeat(501); // 501 characters - exceeds limit
    const invalidParams = {
      title: 'Valid title',
      description: longDescription,
      type: ResearchTaskType.SCRAPE,
      url: 'https://example.com',
      canDiscoverLinks: true,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    // Act & Assert
    await expect(create(mockUser, invalidParams, adapters)).rejects.toThrow();
  });

  it('should accept description with exactly 500 characters', async () => {
    // Arrange
    const exactLengthDescription = 'a'.repeat(500); // Exactly 500 characters
    const params = {
      title: 'Valid title',
      description: exactLengthDescription,
      type: ResearchTaskType.SCRAPE,
      urls: ['https://example.com'],
      canDiscoverLinks: true,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    const expectedTask: IResearchTask = mockResearchTask({
      userId: mockUser.id,
      title: params.title,
      description: params.description,
      researchAgentId: params.researchAgentId,
      urls: params.urls,
      canDiscoverLinks: params.canDiscoverLinks,
      executionType: params.executionType,
    });

    (mockResearchTaskRepo.create as Mock).mockResolvedValueOnce(expectedTask);

    // Act
    const result = await create(mockUser, params, adapters);

    // Assert
    expect(result).toEqual(expectedTask);
    expect(result.description).toBe(exactLengthDescription);
  });

  it.each(['invalid-url', 'not-a-url', 'ftp://invalid.com', 'www.example.com', 'example.com', ''])(
    'should throw validation error for invalid URL: %s',
    async invalidUrl => {
      // Arrange
      const invalidParams = {
        title: 'Valid title',
        description: 'Valid description',
        type: ResearchTaskType.SCRAPE,
        url: invalidUrl,
        canDiscoverLinks: true,
        researchAgentId: 'test-research-agent-id',
        executionType: ResearchTaskExecutionType.ON_DEMAND,
      };

      // Act & Assert
      await expect(create(mockUser, invalidParams, adapters)).rejects.toThrow();
    }
  );

  it.each([
    'https://example.com',
    'http://example.com',
    'https://www.example.com/path/to/resource',
    'https://subdomain.example.com:8080/path?query=value',
    'http://localhost:3000',
  ])('should accept valid URL: %s', async validUrl => {
    // Arrange
    const params = {
      title: 'Valid title',
      description: 'Valid description',
      type: ResearchTaskType.SCRAPE,
      urls: [validUrl],
      canDiscoverLinks: true,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    const expectedTask: IResearchTask = mockResearchTask({
      userId: mockUser.id,
      title: params.title,
      description: params.description,
      researchAgentId: params.researchAgentId,
      urls: params.urls,
      canDiscoverLinks: params.canDiscoverLinks,
      executionType: params.executionType,
    });

    (mockResearchTaskRepo.create as Mock).mockResolvedValueOnce(expectedTask);

    // Act
    const result = await create(mockUser, params, adapters);

    // Assert
    expect(result).toEqual(expectedTask);
    expect((result as any).urls[0]).toBe(validUrl);
  });

  it.each([
    { frequency: ResearchTaskPeriodicFrequencyType.DAILY, description: 'daily' },
    { frequency: ResearchTaskPeriodicFrequencyType.WEEKLY, description: 'weekly' },
    { frequency: ResearchTaskPeriodicFrequencyType.MONTHLY, description: 'monthly' },
  ])('should create a $description periodic research task successfully', async ({ frequency }) => {
    // Arrange
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 30); // 30 days from now

    const params = {
      title: 'Test Research Task',
      description: 'Test Description',
      type: ResearchTaskType.SCRAPE,
      researchAgentId: 'test-research-agent-id',
      urls: ['https://example.com'],
      canDiscoverLinks: true,
      executionType: ResearchTaskExecutionType.PERIODIC,
      executionPeriodicStartAt: startDate,
      executionPeriodicEndAt: endDate,
      executionPeriodicFrequency: frequency,
    };

    (mockResearchAgentRepo.findByIdAndUserId as Mock).mockResolvedValue(mockResearchAgent);
    (mockResearchTaskRepo.create as Mock).mockResolvedValue({ ...params, id: 'test-id' });

    // Act
    const result = await create(mockUser, params, adapters);

    // Assert
    expect(result).toBeDefined();
    expect(result.executionType).toBe(ResearchTaskExecutionType.PERIODIC);
    expect((result as any).executionPeriodicStartAt).toBe(startDate);
    expect((result as any).executionPeriodicEndAt).toBe(endDate);
    expect(mockTaskSchedulerCreate).toHaveBeenCalledWith(
      {
        handler: TaskScheduleHandler.RESEARCH_TASK_PROCESS,
        payload: {
          id: result.id,
          userId: mockUser.id,
        },
        processDate: startDate,
      },
      {
        db: adapters.db,
      }
    );
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('should create a scheduled research task successfully', async () => {
    // Arrange
    const scheduledDate = new Date();
    scheduledDate.setDate(scheduledDate.getDate() + 1); // tomorrow

    const params = {
      title: 'Test Research Task',
      description: 'Test Description',
      type: ResearchTaskType.SCRAPE,
      researchAgentId: 'test-research-agent-id',
      urls: ['https://example.com'],
      canDiscoverLinks: true,
      executionType: ResearchTaskExecutionType.SCHEDULED,
      executionScheduledAt: scheduledDate,
    };

    (mockResearchAgentRepo.findByIdAndUserId as Mock).mockResolvedValue(mockResearchAgent);
    (mockResearchTaskRepo.create as Mock).mockResolvedValue({ ...params, id: 'test-id' });

    // Act
    const result = await create(mockUser, params, adapters);

    // Assert
    expect(result).toBeDefined();
    expect(result.executionType).toBe(ResearchTaskExecutionType.SCHEDULED);
    expect((result as any).executionScheduledAt).toBe(scheduledDate);
    expect(mockTaskSchedulerCreate).toHaveBeenCalledWith(
      {
        handler: TaskScheduleHandler.RESEARCH_TASK_PROCESS,
        payload: {
          id: result.id,
          userId: mockUser.id,
        },
        processDate: scheduledDate,
      },
      {
        db: adapters.db,
      }
    );
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('should throw error for periodic task without required dates', async () => {
    // Arrange
    const params = {
      title: 'Test Research Task',
      description: 'Test Description',
      type: ResearchTaskType.SCRAPE,
      researchAgentId: 'test-research-agent-id',
      url: 'https://example.com',
      canDiscoverLinks: true,
      executionType: ResearchTaskExecutionType.PERIODIC,
    };

    // Act & Assert
    await expect(create(mockUser, params, adapters)).rejects.toThrow();
  });

  it('should throw error for scheduled task without scheduled date', async () => {
    // Arrange
    const params = {
      title: 'Test Research Task',
      description: 'Test Description',
      type: ResearchTaskType.SCRAPE,
      researchAgentId: 'test-research-agent-id',
      url: 'https://example.com',
      canDiscoverLinks: true,
      executionType: ResearchTaskExecutionType.SCHEDULED,
    };

    // Act & Assert
    await expect(create(mockUser, params, adapters)).rejects.toThrow();
  });

  it('should create a deep research task successfully', async () => {
    // Arrange
    const params = {
      title: 'Deep Research Task',
      description: 'Test deep research description',
      type: ResearchTaskType.DEEP_RESEARCH,
      maxDepth: 5,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    const expectedTask: IResearchTask = mockResearchTask({
      userId: mockUser.id,
      title: params.title,
      description: params.description,
      researchAgentId: params.researchAgentId,
      type: ResearchTaskType.DEEP_RESEARCH,
      maxDepth: params.maxDepth,
      executionType: params.executionType,
    });

    (mockResearchTaskRepo.create as Mock).mockResolvedValueOnce(expectedTask);

    // Act
    const result = await create(mockUser, params, adapters);

    // Assert
    expect(result).toEqual(expectedTask);
    expect(mockResearchTaskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mockUser.id,
        title: params.title,
        description: params.description,
        researchAgentId: params.researchAgentId,
        type: ResearchTaskType.DEEP_RESEARCH,
        maxDepth: params.maxDepth,
        executionType: params.executionType,
        status: ResearchTaskStatus.PENDING,
        organizationId: undefined,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      })
    );
    expect(mockProcess).toHaveBeenCalledWith(expectedTask.id, mockUser.id);
    expect(mockLogger.info).toHaveBeenCalledWith(`Creating research task ${params.title}`);
  });

  it('should create a deep research task with default maxDepth', async () => {
    // Arrange
    const params = {
      title: 'Deep Research Task',
      description: 'Test deep research description',
      type: ResearchTaskType.DEEP_RESEARCH,
      topic: 'climate change impacts',
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    const expectedTask: IResearchTask = mockResearchTask({
      userId: mockUser.id,
      title: params.title,
      description: params.description,
      researchAgentId: params.researchAgentId,
      type: ResearchTaskType.DEEP_RESEARCH,
      topic: params.topic,
      executionType: params.executionType,
    });

    (mockResearchTaskRepo.create as Mock).mockResolvedValueOnce(expectedTask);

    // Act
    const result = await create(mockUser, params, adapters);

    // Assert
    expect(result).toEqual(expectedTask);
    expect(mockProcess).toHaveBeenCalledWith(expectedTask.id, mockUser.id);
  });

  it('should validate deep research topic length limits', async () => {
    // Arrange
    const longTopic = 'a'.repeat(501); // 501 characters - exceeds limit
    const invalidParams = {
      title: 'Deep Research Task',
      description: 'Test description',
      type: ResearchTaskType.DEEP_RESEARCH,
      topic: longTopic,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    // Act & Assert
    await expect(create(mockUser, invalidParams, adapters)).rejects.toThrow();
  });

  it('should validate deep research maxDepth limits', async () => {
    // Arrange - test maxDepth > 10
    const invalidParams = {
      title: 'Deep Research Task',
      description: 'Test description',
      type: ResearchTaskType.DEEP_RESEARCH,
      topic: 'valid topic',
      maxDepth: 15, // Exceeds maximum of 10
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    // Act & Assert
    await expect(create(mockUser, invalidParams, adapters)).rejects.toThrow();
  });

  it('should validate deep research minimum maxDepth', async () => {
    // Arrange - test maxDepth < 1
    const invalidParams = {
      title: 'Deep Research Task',
      description: 'Test description',
      type: ResearchTaskType.DEEP_RESEARCH,
      topic: 'valid topic',
      maxDepth: 0, // Below minimum of 1
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    // Act & Assert
    await expect(create(mockUser, invalidParams, adapters)).rejects.toThrow();
  });

  it('should throw error for unsupported research task type', async () => {
    // Arrange
    const invalidParams = {
      title: 'Test Research Task',
      description: 'Test Description',
      type: ResearchTaskType.SALESFORCE,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    // Act & Assert
    await expect(create(mockUser, invalidParams, adapters)).rejects.toThrow('Task not yet supported: salesforce');
  });

  it('should process a research task', async () => {
    // Arrange
    const params = {
      title: 'Test Research Task',
      description: 'Test Description',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://example.com'],
      canDiscoverLinks: true,
      researchAgentId: 'test-research-agent-id',
      executionType: ResearchTaskExecutionType.ON_DEMAND,
    };

    const expectedTask: IResearchTask = mockResearchTask({ userId: mockUser.id });

    (mockResearchTaskRepo.create as Mock).mockResolvedValueOnce(expectedTask);

    // Act
    const result = await create(mockUser, params, adapters);

    // Assert
    expect(result).toEqual(expectedTask);
    expect(mockProcess).toHaveBeenCalledWith(expectedTask.id, mockUser.id);
    expect(mockLogger.info).toHaveBeenCalledWith(`Creating research task ${params.title}`);
    expect(mockLogger.info).toHaveBeenCalledWith(`Processing research task ${expectedTask.id}`);
  });
});
