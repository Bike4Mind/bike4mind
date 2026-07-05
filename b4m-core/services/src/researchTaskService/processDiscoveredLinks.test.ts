import { describe, it, expect, beforeEach, vi } from 'vitest';
import { processDiscoveredLinks } from './processDiscoveredLinks';
import { NotFoundError, UnprocessableEntityError } from '@bike4mind/utils';
import { ResearchTaskType } from '@bike4mind/common';
import axios from 'axios';
import { createSendStatusUpdate } from './utils';

vi.mock('axios');
const mockedAxios = axios as any;

vi.mock('./utils', () => ({
  createSendStatusUpdate: vi.fn(),
}));

describe('processDiscoveredLinks', () => {
  let mockDb: any;
  let mockLogger: any;
  let mockLLM: any;
  let mockJobs: any;
  let adapters: any;
  let mockResearchTask: any;
  let mockResearchData: any;
  let mockFabFile: any;
  let mockSendStatusUpdate: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      withTransaction: vi.fn().mockImplementation(async fn => fn()),
      researchTasks: {
        findById: vi.fn(),
        update: vi.fn(),
      },
      fabFiles: {
        findById: vi.fn(),
      },
      researchDatas: {
        findByUrlAndOrganizationId: vi.fn(),
        findByUrlAndUserId: vi.fn(),
      },
    };

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };

    mockLLM = {
      complete: vi.fn(),
    };

    mockJobs = {
      researchTasks: {
        downloadRelevantLinks: vi.fn(),
        sendToClient: vi.fn(),
      },
    };

    adapters = {
      db: mockDb,
      logger: mockLogger,
      llm: mockLLM,
      jobs: mockJobs,
    };

    mockResearchTask = {
      id: 'test-task-id',
      type: ResearchTaskType.SCRAPE,
      urls: ['https://example.com'],
      userId: 'test-user-id',
      organizationId: null,
      prompt: 'Test prompt',
      discoveredLinks: [
        {
          url: 'https://example.com/link1',
          sourceUrl: 'https://example.com',
          status: 'pending',
        },
        {
          url: 'https://example.com/link2',
          sourceUrl: 'https://example.com',
          status: 'pending',
        },
      ],
    };

    mockResearchData = {
      id: 'research-data-id',
      fabFileId: 'fab-file-id',
      url: 'https://example.com',
    };

    mockFabFile = {
      id: 'fab-file-id',
      fileUrl: 'https://storage.example.com/file.md',
    };

    mockSendStatusUpdate = vi.fn().mockResolvedValue(undefined);

    (createSendStatusUpdate as any).mockReturnValue(mockSendStatusUpdate);
  });

  it('should process discovered links successfully', async () => {
    // Arrange
    const mockContent = '# Test Content\nThis is test content with links.';
    const mockLLMResponse = JSON.stringify([
      {
        url: 'https://example.com/link1',
        text: 'Link 1 Description',
        relevance: 0.8,
        fileType: 'text/html',
        isDownloadable: false,
        isRecommended: true,
      },
      {
        url: 'https://example.com/link2',
        text: 'Link 2 Description',
        relevance: 0.6,
        fileType: 'application/pdf',
        isDownloadable: true,
        isRecommended: false,
      },
    ]);

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
    mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
    mockedAxios.get.mockResolvedValue({ data: mockContent });
    mockLLM.complete.mockImplementation(async (model, messages, options, callback) => {
      await callback([mockLLMResponse]);
    });

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockDb.researchTasks.findById).toHaveBeenCalledWith('test-task-id');
    expect(mockDb.researchDatas.findByUrlAndUserId).toHaveBeenCalledWith('https://example.com', 'test-user-id');
    expect(mockDb.fabFiles.findById).toHaveBeenCalledWith('fab-file-id');
    expect(mockedAxios.get).toHaveBeenCalledWith('https://storage.example.com/file.md');
    expect(mockLLM.complete).toHaveBeenCalled();
    expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveredLinks: expect.arrayContaining([
          expect.objectContaining({
            url: 'https://example.com/link1',
            status: 'completed',
            text: 'Link 1 Description',
            relevance: 0.8,
            fileType: 'text/html',
            isDownloadable: false,
            isRecommended: true,
          }),
          expect.objectContaining({
            url: 'https://example.com/link2',
            status: 'completed',
            text: 'Link 2 Description',
            relevance: 0.6,
            fileType: 'application/pdf',
            isDownloadable: true,
            isRecommended: false,
          }),
        ]),
      })
    );
    expect(mockJobs.researchTasks.downloadRelevantLinks).toHaveBeenCalledWith('test-task-id', 'test-user-id');
  });

  it('should throw NotFoundError when research task is not found', async () => {
    // Arrange
    mockDb.researchTasks.findById.mockResolvedValue(null);

    // Act & Assert
    await expect(processDiscoveredLinks({ id: 'non-existent-task' }, adapters)).rejects.toThrow(NotFoundError);
    expect(mockDb.researchTasks.findById).toHaveBeenCalledWith('non-existent-task');
  });

  it('should throw UnprocessableEntityError when task type is not SCRAPE', async () => {
    // Arrange
    const nonScrapeTask = {
      ...mockResearchTask,
      type: ResearchTaskType.SALESFORCE,
    };
    mockDb.researchTasks.findById.mockResolvedValue(nonScrapeTask);

    // Act & Assert
    await expect(processDiscoveredLinks({ id: 'test-task-id' }, adapters)).rejects.toThrow(UnprocessableEntityError);
  });

  it('should handle organization-based research data lookup', async () => {
    // Arrange
    const orgTask = {
      ...mockResearchTask,
      organizationId: 'test-org-id',
    };
    const mockContent = '# Test Content\nThis is test content.';

    mockDb.researchTasks.findById.mockResolvedValue(orgTask);
    mockDb.researchDatas.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
    mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
    mockedAxios.get.mockResolvedValue({ data: mockContent });
    mockLLM.complete.mockImplementation(async (model, messages, options, callback) => {
      await callback([JSON.stringify([])]);
    });

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockDb.researchDatas.findByUrlAndOrganizationId).toHaveBeenCalledWith('https://example.com', 'test-org-id');
    expect(mockDb.researchDatas.findByUrlAndUserId).not.toHaveBeenCalled();
  });

  it('should mark task as failed when research data is not found', async () => {
    // Arrange
    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(null);

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        statusFailedMessage: expect.any(String),
        statusFailedAt: expect.any(Date),
      })
    );
  });

  it('should mark task as failed when fab file is not found', async () => {
    // Arrange
    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
    mockDb.fabFiles.findById.mockResolvedValue(null);

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        statusFailedMessage: expect.any(String),
        statusFailedAt: expect.any(Date),
      })
    );
  });

  it('should mark task as failed when fab file has no fileUrl', async () => {
    // Arrange
    const fabFileWithoutUrl = {
      ...mockFabFile,
      fileUrl: null,
    };

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
    mockDb.fabFiles.findById.mockResolvedValue(fabFileWithoutUrl);

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        statusFailedMessage: expect.any(String),
        statusFailedAt: expect.any(Date),
      })
    );
  });

  it('should mark task as failed when content fetch fails', async () => {
    // Arrange
    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
    mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
    mockedAxios.get.mockRejectedValue(new Error('Network error'));

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        statusFailedMessage: expect.any(String),
        statusFailedAt: expect.any(Date),
      })
    );
  });

  it('should handle LLM processing failure with retry logic', async () => {
    // Arrange
    const mockContent = '# Test Content\nThis is test content.';
    let attemptCount = 0;

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
    mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
    mockedAxios.get.mockResolvedValue({ data: mockContent });
    mockLLM.complete.mockImplementation(async (model, messages, options, callback) => {
      attemptCount++;
      if (attemptCount < 2) {
        throw new Error('LLM processing failed');
      }
      await callback([JSON.stringify([])]);
    });

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('RETRY: Failed to extract links'));
  });

  it('should mark links as failed after retry attempts are exhausted', async () => {
    // Arrange
    const mockContent = '# Test Content\nThis is test content.';

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
    mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
    mockedAxios.get.mockResolvedValue({ data: mockContent });
    mockLLM.complete.mockRejectedValue(new Error('LLM processing failed'));

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
    expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveredLinks: expect.arrayContaining([
          expect.objectContaining({
            url: 'https://example.com/link1',
            status: 'failed',
          }),
          expect.objectContaining({
            url: 'https://example.com/link2',
            status: 'failed',
          }),
        ]),
      })
    );
  });

  it('should handle JSON parsing with code block format', async () => {
    // Arrange
    const mockContent = '# Test Content\nThis is test content.';
    const mockLLMResponse = `\`\`\`json
[
  {
    "url": "https://example.com/link1",
    "text": "Link 1 Description",
    "relevance": 0.8,
    "fileType": "text/html",
    "isDownloadable": false,
    "isRecommended": true
  }
]
\`\`\``;

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
    mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
    mockedAxios.get.mockResolvedValue({ data: mockContent });
    mockLLM.complete.mockImplementation(async (model, messages, options, callback) => {
      await callback([mockLLMResponse]);
    });

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        discoveredLinks: expect.arrayContaining([
          expect.objectContaining({
            url: 'https://example.com/link1',
            status: 'completed',
            text: 'Link 1 Description',
            relevance: 0.8,
          }),
        ]),
      })
    );
  });

  it('should skip processing when no pending links exist for a URL', async () => {
    // Arrange
    const taskWithNoLinks = {
      ...mockResearchTask,
      discoveredLinks: [
        {
          url: 'https://example.com/link1',
          sourceUrl: 'https://example.com',
          status: 'completed',
        },
      ],
    };

    mockDb.researchTasks.findById.mockResolvedValue(taskWithNoLinks);

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockDb.researchDatas.findByUrlAndUserId).not.toHaveBeenCalled();
    expect(mockLLM.complete).not.toHaveBeenCalled();
    expect(mockJobs.researchTasks.downloadRelevantLinks).toHaveBeenCalledWith('test-task-id', 'test-user-id');
  });

  it('should process multiple URLs sequentially', { timeout: 15000 }, async () => {
    // Arrange
    const multiUrlTask = {
      ...mockResearchTask,
      urls: ['https://example.com', 'https://test.com'],
      discoveredLinks: [
        {
          url: 'https://example.com/link1',
          sourceUrl: 'https://example.com',
          status: 'pending',
        },
        {
          url: 'https://test.com/link1',
          sourceUrl: 'https://test.com',
          status: 'pending',
        },
      ],
    };
    const mockContent = '# Test Content\nThis is test content.';

    mockDb.researchTasks.findById.mockResolvedValue(multiUrlTask);
    mockDb.researchDatas.findByUrlAndUserId
      .mockResolvedValueOnce(mockResearchData)
      .mockResolvedValueOnce(mockResearchData);
    mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
    mockedAxios.get.mockResolvedValue({ data: mockContent });
    mockLLM.complete.mockImplementation(async (model, messages, options, callback) => {
      await callback([JSON.stringify([])]);
    });

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockDb.researchDatas.findByUrlAndUserId).toHaveBeenCalledTimes(2);
    expect(mockDb.researchDatas.findByUrlAndUserId).toHaveBeenCalledWith('https://example.com', 'test-user-id');
    expect(mockDb.researchDatas.findByUrlAndUserId).toHaveBeenCalledWith('https://test.com', 'test-user-id');
  });

  it('should handle concurrent batch processing', async () => {
    // Arrange
    const taskWithManyLinks = {
      ...mockResearchTask,
      discoveredLinks: Array.from({ length: 150 }, (_, i) => ({
        url: `https://example.com/link${i + 1}`,
        sourceUrl: 'https://example.com',
        status: 'pending',
      })),
    };
    const mockContent = '# Test Content\nThis is test content.';

    mockDb.researchTasks.findById.mockResolvedValue(taskWithManyLinks);
    mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
    mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
    mockedAxios.get.mockResolvedValue({ data: mockContent });
    mockLLM.complete.mockImplementation(async (model, messages, options, callback) => {
      await callback([
        JSON.stringify([
          {
            url: 'https://example.com/processed1',
            text: 'Test',
            relevance: 0.8,
            fileType: 'text/html',
            isDownloadable: false,
            isRecommended: true,
          },
        ]),
      ]);
    });

    // Act
    await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockLLM.complete).toHaveBeenCalledTimes(3); // 150 links / 50 batch size = 3 batches
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('** RUNNING BATCH 1/3**'));
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('** RUNNING BATCH 2/3**'));
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('** RUNNING BATCH 3/3**'));
  });

  describe('Progress Tracking', () => {
    it('should send progress updates within 41-70% range', async () => {
      // Arrange
      const mockContent = '# Test Content\nThis is test content.';
      const mockLLMResponse = JSON.stringify([
        {
          url: 'https://example.com/link1',
          text: 'Link 1 Description',
          relevance: 0.8,
          fileType: 'text/html',
          isDownloadable: false,
          isRecommended: true,
        },
      ]);

      mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
      mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
      mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
      mockedAxios.get.mockResolvedValue({ data: mockContent });
      mockLLM.complete.mockImplementation(async (model, messages, options, callback) => {
        await callback([mockLLMResponse]);
      });

      // Act
      await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      // Verify createSendStatusUpdate was called with correct parameters
      expect(createSendStatusUpdate).toHaveBeenCalledWith(
        mockResearchTask,
        expect.anything(), // queueRunner
        mockJobs.researchTasks.sendToClient,
        mockLogger,
        expect.objectContaining({
          baseProgress: 41,
          maxProgress: 70,
        })
      );
    });

    it('should distribute progress across multiple batches within 41-70% range', async () => {
      // Arrange
      const taskWithMultipleBatches = {
        ...mockResearchTask,
        discoveredLinks: Array.from({ length: 100 }, (_, i) => ({
          url: `https://example.com/link${i + 1}`,
          sourceUrl: 'https://example.com',
          status: 'pending',
        })),
      };
      const mockContent = '# Test Content\nThis is test content.';

      mockDb.researchTasks.findById.mockResolvedValue(taskWithMultipleBatches);
      mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
      mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
      mockedAxios.get.mockResolvedValue({ data: mockContent });
      mockLLM.complete.mockImplementation(async (model, messages, options, callback) => {
        await callback([JSON.stringify([])]);
      });

      // Act
      await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      // Verify createSendStatusUpdate was called with correct parameters
      expect(createSendStatusUpdate).toHaveBeenCalledWith(
        taskWithMultipleBatches,
        expect.anything(), // queueRunner
        mockJobs.researchTasks.sendToClient,
        mockLogger,
        expect.objectContaining({
          baseProgress: 41,
          maxProgress: 70,
        })
      );
    });

    it('should include batch progress in status messages', async () => {
      // Arrange
      const taskWithMultipleBatches = {
        ...mockResearchTask,
        discoveredLinks: Array.from({ length: 100 }, (_, i) => ({
          url: `https://example.com/link${i + 1}`,
          sourceUrl: 'https://example.com',
          status: 'pending',
        })),
      };
      const mockContent = '# Test Content\nThis is test content.';

      mockDb.researchTasks.findById.mockResolvedValue(taskWithMultipleBatches);
      mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
      mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
      mockedAxios.get.mockResolvedValue({ data: mockContent });
      mockLLM.complete.mockImplementation(async (model, messages, options, callback) => {
        await callback([JSON.stringify([])]);
      });

      // Act
      await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      // Verify sendStatusUpdate was called with batch-related messages
      const sendStatusUpdateCalls = mockSendStatusUpdate.mock.calls;
      const statusMessages = sendStatusUpdateCalls.map(call => call[0]); // First argument is the status message

      // Should contain batch indicators and completion messages
      expect(statusMessages.some(msg => msg.includes('batch'))).toBe(true);
    });

    it('should handle sendToClient errors gracefully', async () => {
      // Arrange
      const mockContent = '# Test Content\nThis is test content.';

      mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
      mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
      mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
      mockedAxios.get.mockResolvedValue({ data: mockContent });
      mockLLM.complete.mockImplementation(async (model, messages, options, callback) => {
        await callback([JSON.stringify([])]);
      });
      mockJobs.researchTasks.sendToClient.mockRejectedValue(new Error('WebSocket error'));

      // Act
      await processDiscoveredLinks({ id: 'test-task-id' }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      // Process should still complete successfully even with sendToClient errors
      expect(mockJobs.researchTasks.downloadRelevantLinks).toHaveBeenCalled();
    });

    it('should not send progress updates when sendToClient is not available', async () => {
      // Arrange
      const adaptersWithoutSendToClient = {
        ...adapters,
        jobs: {
          researchTasks: {
            downloadRelevantLinks: vi.fn(),
          },
        },
      };
      const mockContent = '# Test Content\nThis is test content.';

      mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
      mockDb.researchDatas.findByUrlAndUserId.mockResolvedValue(mockResearchData);
      mockDb.fabFiles.findById.mockResolvedValue(mockFabFile);
      mockedAxios.get.mockResolvedValue({ data: mockContent });
      mockLLM.complete.mockImplementation(async (model, messages, options, callback) => {
        await callback([JSON.stringify([])]);
      });

      // Act
      await processDiscoveredLinks({ id: 'test-task-id' }, adaptersWithoutSendToClient);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      // Verify createSendStatusUpdate was called with undefined sendToClient
      expect(createSendStatusUpdate).toHaveBeenCalledWith(
        mockResearchTask,
        expect.anything(),
        undefined, // sendToClient should be undefined
        mockLogger,
        expect.anything()
      );

      // Process should still complete successfully
      expect(adaptersWithoutSendToClient.jobs.researchTasks.downloadRelevantLinks).toHaveBeenCalled();
    });
  });
});
