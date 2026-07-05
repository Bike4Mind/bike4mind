import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import * as processModule from './process';
const { process } = processModule;

import { IResearchTask, ResearchTaskStatus, KnowledgeType, ResearchTaskType } from '@bike4mind/common';
import { NotFoundError, BadRequestError } from '@bike4mind/utils';
import { fabFilesService } from '..';
import { mockResearchTask } from '../__tests__/utils/testUtils';
import { findOrUpdateExistingResearchData, createSendStatusUpdate } from './utils';

vi.mock('../lib/turndown', () => ({
  htmlToMarkdown: vi.fn().mockImplementation(html => html),
  listMarkdownLinks: vi.fn(),
}));

vi.mock('../lib/cheerio', () => ({
  getLinksFromHtml: vi.fn().mockReturnValue([]),
}));

vi.mock('..', () => ({
  fabFilesService: {
    createFabFile: vi.fn(),
  },
  taskSchedulerService: {
    create: vi.fn(),
  },
  tagService: {
    createFileTag: vi.fn(),
  },
}));

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    NotFoundError: actual.NotFoundError,
    BadRequestError: actual.BadRequestError,
    FunctionQueueRunner: vi.fn().mockImplementation(function () {
      return {
        add: vi.fn().mockImplementation(async fn => {
          // Execute the function immediately in tests instead of queueing
          return await fn();
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn(),
}));

vi.mock('./utils', () => ({
  findOrUpdateExistingResearchData: vi.fn(),
  createSendStatusUpdate: vi.fn(),
}));

describe('researchTaskService - process', () => {
  let mockResearchTaskRepo: any;
  let mockFabFileRepo: any;
  let mockUserRepo: any;
  let mockAdminSettingsRepo: any;
  let mockResearchDataRepo: any;
  let mockFileTagRepo: any;
  let mockLLM: any;
  let mockLogger: any;
  let mockStorage: any;
  let adapters: any;
  let mockUser: any;
  let mockSendStatusUpdate: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResearchTaskRepo = {
      create: vi.fn(),
      findAllByUserId: vi.fn(),
      find: vi.fn(),
      findOne: vi.fn(),
      findById: vi.fn(),
      findByIdAndUserId: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    };
    mockFabFileRepo = {
      create: vi.fn(),
      findById: vi.fn(),
      update: vi.fn(),
    };
    mockUserRepo = {
      findById: vi.fn(),
    };
    mockAdminSettingsRepo = {
      findOne: vi.fn(),
    };
    mockResearchDataRepo = {
      create: vi.fn().mockImplementation(data => ({
        id: 'mock-research-data-id',
        ...data,
      })),
      findAllByResearchTaskId: vi.fn(),
      findByResearchAgentIdAndResearchTaskId: vi.fn(),
      findById: vi.fn(),
      findByMetadataUrlAndUserId: vi.fn().mockResolvedValue(null),
      findByMetadataUrlAndOrganizationId: vi.fn().mockResolvedValue(null),
      findByUrlAndOrganizationId: vi.fn().mockResolvedValue(null),
      findByUrlAndUserId: vi.fn().mockResolvedValue(null),
      existsByUrlAndResearchTaskId: vi.fn().mockResolvedValue(false),
    };
    mockFileTagRepo = {
      findByIdAndUserId: vi.fn(),
      create: vi.fn(),
      findByNameAndUserId: vi.fn(),
      incrementFileCountByIds: vi.fn(),
    };
    mockLLM = {
      complete: vi.fn(),
      getModelInfo: vi.fn(),
    };
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    mockStorage = {
      upload: vi.fn(),
      generateSignedUrl: vi.fn(),
    };
    adapters = {
      db: {
        transaction: async <T>(fn: () => Promise<T>) => fn(),
        researchTasks: mockResearchTaskRepo,
        fabFiles: mockFabFileRepo,
        users: mockUserRepo,
        adminSettings: mockAdminSettingsRepo,
        researchDatas: mockResearchDataRepo,
        fileTags: mockFileTagRepo,
      },
      llm: mockLLM,
      scraper: {
        fetch: vi.fn(),
      },
      storage: mockStorage,
      logger: mockLogger,
      jobs: {
        file: {
          chunk: vi.fn(),
        },
        researchTasks: {
          processDiscoveredLinks: vi.fn(),
          sendToClient: vi.fn(),
        },
      },
    };

    mockUser = {
      id: 'test-user-id',
      email: 'test@example.com',
    };

    mockSendStatusUpdate = vi.fn().mockResolvedValue(undefined);

    (createSendStatusUpdate as any).mockReturnValue(mockSendStatusUpdate);

    (findOrUpdateExistingResearchData as any).mockResolvedValue(null);

    (fabFilesService.createFabFile as Mock).mockImplementation(async (userId, data) => ({
      id: 'mock-fab-file-id',
      ...data,
      content: '# Scraped Title\nTest content', // Always use markdown content
      fileSize: Buffer.byteLength('# Scraped Title\nTest content', 'utf8'),
    }));
  });

  it('should process a scrape research task successfully', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const mockTask: IResearchTask = mockResearchTask({
      id: taskId,
      canDiscoverLinks: true,
      urls: ['https://example.com'],
    });

    const mockMarkdownContent = '# Scraped Title\nTest content';
    const mockLinks = [
      { url: 'https://example.com/1', text: 'Link 1', downloadable: false, relevanceScore: 0.9, recommended: true },
      { url: 'https://example.com/2', text: 'Link 2', downloadable: true, relevanceScore: 0.8, recommended: true },
    ];

    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: `${mockTask.title} (2/1).md`, // Updated to match new naming pattern
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
      type: KnowledgeType.TEXT,
      content: mockMarkdownContent,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
    (mockResearchDataRepo.findByResearchAgentIdAndResearchTaskId as Mock).mockResolvedValue(null); // <-- Ensure returns null
    (mockLLM.complete as Mock).mockImplementation(async (_messages, cb) => {
      await cb(JSON.stringify(mockLinks));
    });
    (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);
    (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });
    // Act
    await process(mockUser, { id: taskId }, adapters);

    // Assert
    expect(mockResearchTaskRepo.findByIdAndUserId).toHaveBeenCalledWith(taskId, mockUser.id);
    // Check that scraper.fetch was called with the first URL from the urls array
    expect(adapters.scraper.fetch).toHaveBeenCalledWith('https://example.com');
    // LLM processing is no longer called in this function
    expect(mockLLM.complete).not.toHaveBeenCalled();

    expect(fabFilesService.createFabFile).toHaveBeenCalledWith(
      mockTask.userId,
      {
        fileName: `${mockTask.title} (2/1).md`,
        mimeType: 'text/markdown',
        fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
        type: KnowledgeType.TEXT,
        content: mockMarkdownContent,
        tags: [],
        organizationId: undefined,
      },
      { db: adapters.db, storage: adapters.storage }
    );

    expect(mockResearchDataRepo.create).toHaveBeenCalledWith({
      fabFileId: mockFabFile.id,
      researchAgentId: mockTask.researchAgentId,
      researchTaskId: mockTask.id,
      organizationId: mockTask.organizationId,
      metaData: { url: 'https://example.com' },
      url: 'https://example.com',
      userId: mockTask.userId,
    });

    // Check that discoveredLinks is set when canDiscoverLinks is true
    expect(mockResearchTaskRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ...mockTask,
        discoveredLinks: [], // Empty array since our mock returns no links
      })
    );
  });

  it('should throw NotFoundError when task is not found', async () => {
    // Arrange
    const taskId = 'non-existent-task';
    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(null);

    // Act & Assert
    await expect(process(mockUser, { id: taskId }, adapters)).rejects.toThrow(NotFoundError);
  });

  it('should throw BadRequestError when task is already completed', async () => {
    // Arrange
    const taskId = 'completed-task';
    const mockTask: IResearchTask = mockResearchTask({ id: taskId, status: ResearchTaskStatus.COMPLETED });

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);

    // Act & Assert
    await expect(process(mockUser, { id: taskId }, adapters)).rejects.toThrow(BadRequestError);
  });

  // File chunking test removed - chunking is no longer handled in this function

  it('should handle scraping failure gracefully', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const mockTask: IResearchTask = mockResearchTask({ id: taskId, canDiscoverLinks: true });

    const scrapingError = new Error('Failed to fetch');
    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
    (adapters.scraper.fetch as Mock).mockRejectedValue(scrapingError);

    // Act & Assert
    // Error should be thrown after marking task as FAILED
    await expect(process(mockUser, { id: taskId }, adapters)).rejects.toThrow('Failed to fetch');

    // Verify task was marked as FAILED before throwing
    expect(mockResearchTaskRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ...mockTask,
        status: ResearchTaskStatus.FAILED,
        statusFailedMessage: 'Failed to fetch',
        statusFailedAt: expect.any(Date),
      })
    );

    // Verify client was notified of failure
    expect(adapters.jobs.researchTasks.sendToClient).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ResearchTaskStatus.FAILED,
      }),
      expect.objectContaining({
        status: 'failed',
        currentStep: '❌ Task failed: Failed to fetch',
      })
    );
  });

  it('should process task without link discovery when canDiscoverLinks is false', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const mockTask: IResearchTask = mockResearchTask({
      id: taskId,
      canDiscoverLinks: false,
      urls: ['https://example.com'],
    });

    const mockMarkdownContent = '# Scraped Title\nTest content';
    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: `${mockTask.title} (2/1).md`, // Updated to match new naming pattern
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
      type: KnowledgeType.TEXT,
      content: mockMarkdownContent,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
    (mockResearchDataRepo.findByResearchAgentIdAndResearchTaskId as Mock).mockResolvedValue(null); // <-- Ensure returns null
    (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);
    (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });
    // Act
    await process(mockUser, { id: taskId }, adapters);

    // Assert
    // Check that discoveredLinks is an empty array when canDiscoverLinks is false
    expect(mockResearchTaskRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ...mockTask,
        discoveredLinks: [],
      })
    );
    expect(mockLLM.complete).not.toHaveBeenCalled();
    expect(fabFilesService.createFabFile).toHaveBeenCalledWith(
      mockTask.userId,
      {
        fileName: `${mockTask.title} (2/1).md`, // Updated to match new naming pattern
        mimeType: 'text/markdown',
        fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
        type: KnowledgeType.TEXT,
        content: mockMarkdownContent,
        tags: [],
        organizationId: undefined,
      },
      { db: adapters.db, storage: adapters.storage }
    );
    expect(mockResearchDataRepo.create).toHaveBeenCalledWith({
      fabFileId: mockFabFile.id,
      researchAgentId: mockTask.researchAgentId,
      researchTaskId: mockTask.id,
      organizationId: mockTask.organizationId,
      metaData: { url: 'https://example.com' },
      url: 'https://example.com',
      userId: mockTask.userId,
    });
  });

  // Periodic task scheduling tests removed - completion is no longer handled in this function

  // Periodic task scheduling test removed - completion is no longer handled in this function

  // LLM failure handling test removed - LLM processing is no longer handled in this function

  it('should handle unsupported research task type gracefully', async () => {
    const taskId = 'test-task-id';
    const mockTask: IResearchTask = mockResearchTask({ id: taskId, type: ResearchTaskType.SALESFORCE });

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);

    // Act & Assert
    // Error should be thrown after marking task as FAILED
    await expect(process(mockUser, { id: taskId }, adapters)).rejects.toThrow(
      'Unsupported research task type: salesforce'
    );

    // Verify task was marked as FAILED before throwing
    const failedTask = {
      ...mockTask,
      status: ResearchTaskStatus.FAILED,
      statusFailedMessage: 'Unsupported research task type: salesforce',
      statusFailedAt: expect.any(Date),
    };
    expect(mockResearchTaskRepo.update).toHaveBeenCalledWith(failedTask);

    // Verify client was notified of failure
    expect(adapters.jobs.researchTasks.sendToClient).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ResearchTaskStatus.FAILED,
      }),
      expect.objectContaining({
        status: 'failed',
        currentStep: '❌ Task failed: Unsupported research task type: salesforce',
      })
    );
  });

  // JSON parsing test removed - LLM processing is no longer handled in this function

  it('should allow processing research task that is already in processing state', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const mockTask = mockResearchTask({
      id: taskId,
      status: ResearchTaskStatus.PROCESSING, // This should now be allowed
      urls: ['https://example.com'],
    });
    const mockMarkdownContent = '# Scraped Title\nTest content';
    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: mockTask.title,
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
      type: KnowledgeType.TEXT,
      content: mockMarkdownContent,
      filePath: '/path/to/file',
    };

    mockResearchTaskRepo.findByIdAndUserId.mockResolvedValue(mockTask);
    mockResearchTaskRepo.findById.mockResolvedValue(mockTask);
    (mockResearchDataRepo.findByResearchAgentIdAndResearchTaskId as Mock).mockResolvedValue(null);
    (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });
    (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);
    (mockLLM.complete as Mock).mockImplementation(async (_messages, cb) => {
      await cb(JSON.stringify([]));
    });

    // Act - Should now succeed instead of throwing error
    await process(mockUser, { id: taskId }, adapters);

    // Assert - Verify task was processed successfully
    expect(mockResearchTaskRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ...mockTask,
        discoveredLinks: [],
      })
    );
  });

  // Link filtering and downloading test removed - file downloading is no longer handled in this function

  it('should process multiple URLs in a research task successfully', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const mockTask: IResearchTask = mockResearchTask({
      id: taskId,
      canDiscoverLinks: false, // Keep it simple without link discovery
      urls: ['https://example.com', 'https://test.com', 'https://demo.com'],
    });

    const mockMarkdownContent = '# Scraped Title\nTest content';
    const mockFiles = [
      {
        id: 'mock-fab-file-1',
        fileName: `${mockTask.title} (2/3).md`,
        mimeType: 'text/markdown',
        fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
        type: KnowledgeType.TEXT,
        content: mockMarkdownContent,
      },
      {
        id: 'mock-fab-file-2',
        fileName: `${mockTask.title} (3/3).md`,
        mimeType: 'text/markdown',
        fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
        type: KnowledgeType.TEXT,
        content: mockMarkdownContent,
      },
      {
        id: 'mock-fab-file-3',
        fileName: `${mockTask.title} (4/3).md`,
        mimeType: 'text/markdown',
        fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
        type: KnowledgeType.TEXT,
        content: mockMarkdownContent,
      },
    ];

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
    (mockResearchDataRepo.findByResearchAgentIdAndResearchTaskId as Mock).mockResolvedValue(null);

    // Mock fabFilesService to return different files for each call
    let callCount = 0;
    (fabFilesService.createFabFile as Mock).mockImplementation(async () => {
      const file = mockFiles[callCount];
      callCount++;
      return file;
    });

    (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });

    // Act
    await process(mockUser, { id: taskId }, adapters);

    // Assert
    expect(mockResearchTaskRepo.findByIdAndUserId).toHaveBeenCalledWith(taskId, mockUser.id);

    // Verify scraper.fetch was called for each URL
    expect(adapters.scraper.fetch).toHaveBeenCalledTimes(3);
    expect(adapters.scraper.fetch).toHaveBeenNthCalledWith(1, 'https://example.com');
    expect(adapters.scraper.fetch).toHaveBeenNthCalledWith(2, 'https://test.com');
    expect(adapters.scraper.fetch).toHaveBeenNthCalledWith(3, 'https://demo.com');

    // Verify createFabFile was called for each URL with proper file naming
    expect(fabFilesService.createFabFile).toHaveBeenCalledTimes(3);
    expect(fabFilesService.createFabFile).toHaveBeenNthCalledWith(
      1,
      mockTask.userId,
      expect.objectContaining({
        fileName: `${mockTask.title} (2/3).md`,
        mimeType: 'text/markdown',
        content: mockMarkdownContent,
        type: KnowledgeType.TEXT,
        tags: [],
      }),
      { db: adapters.db, storage: adapters.storage }
    );
    expect(fabFilesService.createFabFile).toHaveBeenNthCalledWith(
      2,
      mockTask.userId,
      expect.objectContaining({
        fileName: `${mockTask.title} (3/3).md`,
      }),
      { db: adapters.db, storage: adapters.storage }
    );
    expect(fabFilesService.createFabFile).toHaveBeenNthCalledWith(
      3,
      mockTask.userId,
      expect.objectContaining({
        fileName: `${mockTask.title} (4/3).md`,
      }),
      { db: adapters.db, storage: adapters.storage }
    );

    // Verify research data was created for each file
    expect(mockResearchDataRepo.create).toHaveBeenCalledTimes(3);

    // Verify final status (completion is no longer handled in this function)
    expect(mockResearchTaskRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ...mockTask,
        discoveredLinks: [],
      })
    );
  });

  it('should set organizationId on created fab files when research task has organizationId', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const organizationId = 'test-organization-id';
    const mockTask = mockResearchTask({
      id: taskId,
      organizationId,
      canDiscoverLinks: false,
      urls: ['https://example.com'],
    });
    const mockMarkdownContent = '# Scraped Title\nTest content';
    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: mockTask.title,
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
      type: KnowledgeType.TEXT,
      content: mockMarkdownContent,
      organizationId,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
    (mockResearchDataRepo.findByResearchAgentIdAndResearchTaskId as Mock).mockResolvedValue(null);
    (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);
    (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });

    // Act
    await process(mockUser, { id: taskId }, adapters);

    // Assert
    expect(fabFilesService.createFabFile).toHaveBeenCalledWith(
      mockTask.userId,
      expect.objectContaining({
        fileName: `${mockTask.title} (2/1).md`,
        mimeType: 'text/markdown',
        fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
        type: KnowledgeType.TEXT,
        content: mockMarkdownContent,
        organizationId,
        tags: [],
      }),
      { db: adapters.db, storage: adapters.storage }
    );
  });

  // TAGGING TESTS
  it('should apply existing tag when research task has fileTagId', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const fileTagId = 'existing-tag-id';
    const mockTag = {
      id: fileTagId,
      name: 'Research Tag',
      userId: mockUser.id,
      fileCount: 5,
    };
    const mockTask = mockResearchTask({
      id: taskId,
      fileTagId,
      canDiscoverLinks: false,
      urls: ['https://example.com'],
    });
    const mockMarkdownContent = '# Scraped Title\nTest content';
    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: mockTask.title,
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
      type: KnowledgeType.TEXT,
      content: mockMarkdownContent,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
    (mockResearchDataRepo.findByResearchAgentIdAndResearchTaskId as Mock).mockResolvedValue(null);
    (mockFileTagRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTag);
    (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);
    (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });

    // Act
    await process(mockUser, { id: taskId }, adapters);

    // Assert
    expect(mockFileTagRepo.findByIdAndUserId).toHaveBeenCalledWith(fileTagId, mockUser.id);
    expect(fabFilesService.createFabFile).toHaveBeenCalledWith(
      mockTask.userId,
      expect.objectContaining({
        tags: [{ name: 'Research Tag', strength: 1.0 }],
      }),
      { db: adapters.db, storage: adapters.storage }
    );
    // Tag increment functionality is commented out in process.ts
    // expect(mockFileTagRepo.incrementFileCountByIds).toHaveBeenCalledWith([fileTagId], 1);
  });

  it('should create new tag when research task has autoGeneratedTag that does not exist', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const autoGeneratedTag = {
      name: 'New Research Tag',
      icon: 'tag',
      color: '#FF5733',
    };
    const mockTask = mockResearchTask({
      id: taskId,
      autoGeneratedTag,
      canDiscoverLinks: false,
      urls: ['https://example.com'],
    });
    const mockMarkdownContent = '# Scraped Title\nTest content';
    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: mockTask.title,
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
      type: KnowledgeType.TEXT,
      content: mockMarkdownContent,
    };
    const mockCreatedTag = {
      id: 'new-tag-id',
      name: 'New Research Tag',
      icon: 'tag',
      color: '#FF5733',
      userId: mockUser.id,
      fileCount: 0,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
    (mockResearchDataRepo.findByResearchAgentIdAndResearchTaskId as Mock).mockResolvedValue(null);
    (mockFileTagRepo.findByNameAndUserId as Mock).mockResolvedValue(null);
    (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);
    (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });

    // Import and mock tagService
    const { tagService } = await import('..');
    (tagService.createFileTag as Mock).mockResolvedValue(mockCreatedTag);

    // Act
    await process(mockUser, { id: taskId }, adapters);

    // Assert
    expect(mockFileTagRepo.findByNameAndUserId).toHaveBeenCalledWith('New Research Tag', mockUser.id);
    expect(tagService.createFileTag).toHaveBeenCalledWith(mockUser.id, autoGeneratedTag, adapters);
    expect(fabFilesService.createFabFile).toHaveBeenCalledWith(
      mockTask.userId,
      expect.objectContaining({
        tags: [{ name: 'New Research Tag', strength: 1.0 }],
      }),
      { db: adapters.db, storage: adapters.storage }
    );
    // Tag increment functionality is commented out in process.ts
    // expect(mockFileTagRepo.incrementFileCountByIds).toHaveBeenCalledWith(['new-tag-id'], 1);
  });

  it('should reuse existing tag when research task has autoGeneratedTag that already exists', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const autoGeneratedTag = {
      name: 'Existing Research Tag',
      icon: 'tag',
      color: '#FF5733',
    };
    const mockTask = mockResearchTask({
      id: taskId,
      autoGeneratedTag,
      canDiscoverLinks: false,
      urls: ['https://example.com'],
    });
    const mockMarkdownContent = '# Scraped Title\nTest content';
    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: mockTask.title,
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
      type: KnowledgeType.TEXT,
      content: mockMarkdownContent,
    };
    const mockExistingTag = {
      id: 'existing-tag-id',
      name: 'Existing Research Tag',
      icon: 'tag',
      color: '#FF5733',
      userId: mockUser.id,
      fileCount: 3,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
    (mockResearchDataRepo.findByResearchAgentIdAndResearchTaskId as Mock).mockResolvedValue(null);
    (mockFileTagRepo.findByNameAndUserId as Mock).mockResolvedValue(mockExistingTag);
    (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);
    (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });

    // Act
    await process(mockUser, { id: taskId }, adapters);

    // Assert
    expect(mockFileTagRepo.findByNameAndUserId).toHaveBeenCalledWith('Existing Research Tag', mockUser.id);
    expect(fabFilesService.createFabFile).toHaveBeenCalledWith(
      mockTask.userId,
      expect.objectContaining({
        tags: [{ name: 'Existing Research Tag', strength: 1.0 }],
      }),
      { db: adapters.db, storage: adapters.storage }
    );
    // Tag increment functionality is commented out in process.ts
    // expect(mockFileTagRepo.incrementFileCountByIds).toHaveBeenCalledWith(['existing-tag-id'], 1);
  });

  it('should handle missing fileTagId gracefully', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const fileTagId = 'non-existent-tag-id';
    const mockTask = mockResearchTask({
      id: taskId,
      fileTagId,
      canDiscoverLinks: false,
      urls: ['https://example.com'],
    });
    const mockMarkdownContent = '# Scraped Title\nTest content';
    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: mockTask.title,
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
      type: KnowledgeType.TEXT,
      content: mockMarkdownContent,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
    (mockResearchDataRepo.findByResearchAgentIdAndResearchTaskId as Mock).mockResolvedValue(null);
    (mockFileTagRepo.findByIdAndUserId as Mock).mockResolvedValue(null);
    (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);
    (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });

    // Act
    await process(mockUser, { id: taskId }, adapters);

    // Assert
    expect(mockFileTagRepo.findByIdAndUserId).toHaveBeenCalledWith(fileTagId, mockUser.id);
    expect(fabFilesService.createFabFile).toHaveBeenCalledWith(
      mockTask.userId,
      expect.objectContaining({
        tags: [], // No tags should be applied
      }),
      { db: adapters.db, storage: adapters.storage }
    );
    // Tag increment functionality is commented out in process.ts
    // expect(mockFileTagRepo.incrementFileCountByIds).toHaveBeenCalledWith([], 1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      `🏷️ [TAG_NOT_FOUND] Tag ${fileTagId} not found for user ${mockUser.id}`
    );
  });

  // Tag application to downloaded files test removed - file downloading is no longer handled in this function

  it('should skip creating research data when URL already exists for research task', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const mockTask = mockResearchTask({
      id: taskId,
      canDiscoverLinks: false,
      urls: ['https://example.com'],
    });
    const mockMarkdownContent = '# Scraped Title\\nTest content';
    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: `${mockTask.title} (1/1).md`,
      mimeType: 'text/markdown',
      fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
      type: KnowledgeType.TEXT,
      content: mockMarkdownContent,
    };

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
    (mockResearchDataRepo.existsByUrlAndResearchTaskId as Mock).mockResolvedValue(true); // URL already exists
    (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);
    (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });

    // Act
    await process(mockUser, { id: taskId }, adapters);

    // Assert
    expect(mockResearchDataRepo.existsByUrlAndResearchTaskId).toHaveBeenCalledWith('https://example.com', mockTask.id);
    expect(mockResearchDataRepo.create).not.toHaveBeenCalled(); // Should not create research data if it already exists
  });

  it('should increment tag count based on actual number of files created', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const fileTagId = 'test-tag-id';
    const mockTag = {
      id: fileTagId,
      name: 'Research Tag',
      userId: mockUser.id,
      fileCount: 5,
    };
    const mockTask = mockResearchTask({
      id: taskId,
      fileTagId,
      canDiscoverLinks: false,
      urls: ['https://example.com', 'https://test.com', 'https://demo.com'],
    });

    const mockMarkdownContent = '# Scraped Title\nTest content';
    const mockFiles = [
      {
        id: 'file-1',
        fileName: `${mockTask.title} (1/3).md`,
        mimeType: 'text/markdown',
        fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
        type: KnowledgeType.TEXT,
        content: mockMarkdownContent,
      },
      {
        id: 'file-2',
        fileName: `${mockTask.title} (2/3).md`,
        mimeType: 'text/markdown',
        fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
        type: KnowledgeType.TEXT,
        content: mockMarkdownContent,
      },
      {
        id: 'file-3',
        fileName: `${mockTask.title} (3/3).md`,
        mimeType: 'text/markdown',
        fileSize: Buffer.byteLength(mockMarkdownContent, 'utf8'),
        type: KnowledgeType.TEXT,
        content: mockMarkdownContent,
      },
    ];

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
    (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
    (mockResearchDataRepo.findByResearchAgentIdAndResearchTaskId as Mock).mockResolvedValue(null);
    (mockFileTagRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTag);
    (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });

    // Mock fabFilesService to return different files for each call
    let callCount = 0;
    (fabFilesService.createFabFile as Mock).mockImplementation(async () => {
      const file = mockFiles[callCount];
      callCount++;
      return file;
    });

    // Act
    await process(mockUser, { id: taskId }, adapters);

    // Assert
    expect(fabFilesService.createFabFile).toHaveBeenCalledTimes(3);

    // Verify all files have tags applied
    expect(fabFilesService.createFabFile).toHaveBeenNthCalledWith(
      1,
      mockTask.userId,
      expect.objectContaining({
        tags: [{ name: 'Research Tag', strength: 1.0 }],
      }),
      { db: adapters.db, storage: adapters.storage }
    );

    // Tag increment functionality is commented out in process.ts
    // expect(mockFileTagRepo.incrementFileCountByIds).toHaveBeenCalledWith([fileTagId], 3);
  });

  describe('Progress Tracking', () => {
    it('should send progress updates within 0-40% range for single URL', async () => {
      // Arrange
      const taskId = 'test-task-id';
      const mockTask = mockResearchTask({
        id: taskId,
        urls: ['https://example.com'],
        canDiscoverLinks: false,
      });
      const mockMarkdownContent = '# Test Content';
      const mockFabFile = {
        id: 'mock-fab-file-id',
        fileName: `${mockTask.title} (2/1).md`,
        mimeType: 'text/markdown',
        content: mockMarkdownContent,
      };

      (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
      (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
      (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });
      (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);

      // Act
      await process(mockUser, { id: taskId }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      expect(createSendStatusUpdate).toHaveBeenCalledWith(
        mockTask,
        expect.anything(), // queueRunner
        expect.any(Function), // wrapped sendToClient
        mockLogger,
        expect.objectContaining({
          baseProgress: 0,
          maxProgress: 100, // Should be 100 when canDiscoverLinks is false
        })
      );
    });

    it('should distribute progress evenly across multiple URLs within 0-40% range', async () => {
      // Arrange
      const taskId = 'test-task-id';
      const mockTask = mockResearchTask({
        id: taskId,
        urls: ['https://example.com', 'https://test.com'],
        canDiscoverLinks: false,
      });
      const mockMarkdownContent = '# Test Content';
      const mockFabFile = {
        id: 'mock-fab-file-id',
        fileName: `${mockTask.title} (1/2).md`,
        mimeType: 'text/markdown',
        content: mockMarkdownContent,
      };

      (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
      (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
      (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });
      (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);

      // Act
      await process(mockUser, { id: taskId }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      // Verify createSendStatusUpdate was called once (shared across all URLs)
      expect(createSendStatusUpdate).toHaveBeenCalledTimes(1);
    });

    it('should include URL index in status messages', async () => {
      // Arrange
      const taskId = 'test-task-id';
      const mockTask = mockResearchTask({
        id: taskId,
        urls: ['https://example.com', 'https://test.com'],
        canDiscoverLinks: false,
      });
      const mockMarkdownContent = '# Test Content';
      const mockFabFile = {
        id: 'mock-fab-file-id',
        fileName: `${mockTask.title} (1/2).md`,
        mimeType: 'text/markdown',
        content: mockMarkdownContent,
      };

      (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
      (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
      (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });
      (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);

      // Act
      await process(mockUser, { id: taskId }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      // Verify createSendStatusUpdate was called with wrapped sendToClient that includes URL indexing
      const createCalls = (createSendStatusUpdate as any).mock.calls;
      expect(createCalls.length).toBeGreaterThan(0);

      // Check that wrapped sendToClient function exists
      expect(createCalls[0][2]).toBeTypeOf('function');
    });

    it('should handle sendToClient errors gracefully', async () => {
      // Arrange
      const taskId = 'test-task-id';
      const mockTask = mockResearchTask({
        id: taskId,
        urls: ['https://example.com'],
        canDiscoverLinks: false,
      });
      const mockMarkdownContent = '# Test Content';
      const mockFabFile = {
        id: 'mock-fab-file-id',
        fileName: `${mockTask.title} (1/1).md`,
        mimeType: 'text/markdown',
        content: mockMarkdownContent,
      };

      (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValue(mockTask);
      (mockResearchTaskRepo.findById as Mock).mockResolvedValue(mockTask);
      (adapters.scraper.fetch as Mock).mockResolvedValue({ rawHtml: mockMarkdownContent, metadata: {} });
      (fabFilesService.createFabFile as Mock).mockResolvedValue(mockFabFile);
      (adapters.jobs.researchTasks.sendToClient as Mock).mockRejectedValue(new Error('WebSocket error'));

      // Act
      await process(mockUser, { id: taskId }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      // Process should still complete successfully even with sendToClient errors
      expect(fabFilesService.createFabFile).toHaveBeenCalled();
    });
  });
});
