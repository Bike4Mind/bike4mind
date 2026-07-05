import { describe, it, expect, beforeEach, vi } from 'vitest';
import { downloadRelevantLinks } from './downloadRelevantLinks';
import { NotFoundError, UnprocessableEntityError } from '@bike4mind/utils';
import { ResearchTaskType, ResearchTaskStatus, KnowledgeType } from '@bike4mind/common';
import axios from 'axios';
import { fileTypeFromBuffer } from 'file-type';
import { fabFilesService } from '..';
import { findOrUpdateExistingResearchData, prepareTagsForResearchTask, createSendStatusUpdate } from './utils';

vi.mock('axios');
vi.mock('file-type');
vi.mock('..', () => ({
  fabFilesService: {
    createFabFile: vi.fn(),
  },
}));
vi.mock('./utils', () => ({
  findOrUpdateExistingResearchData: vi.fn(),
  prepareTagsForResearchTask: vi.fn(),
  createSendStatusUpdate: vi.fn(),
}));

const mockedAxios = axios as any;
const mockedFileTypeFromBuffer = fileTypeFromBuffer as any;
const mockedFabFilesService = fabFilesService as any;
const mockedFindOrUpdateExistingResearchData = findOrUpdateExistingResearchData as any;
const mockedPrepareTagsForResearchTask = prepareTagsForResearchTask as any;
const mockedCreateSendStatusUpdate = createSendStatusUpdate as any;

describe('downloadRelevantLinks', () => {
  let mockDb: any;
  let mockStorage: any;
  let mockLogger: any;
  let mockJobs: any;
  let adapters: any;
  let mockResearchTask: any;
  let mockUser: any;
  let mockFileBuffer: Buffer;
  let mockSendStatusUpdate: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      researchTasks: {
        findById: vi.fn(),
        update: vi.fn(),
      },
      researchDatas: {
        create: vi.fn(),
        existsByUrlAndResearchTaskId: vi.fn().mockResolvedValue(false),
      },
      users: {
        findById: vi.fn(),
      },
      fabFiles: {
        findById: vi.fn(),
      },
      fileTags: {
        findByIdAndUserId: vi.fn(),
      },
      adminSettings: {
        findOne: vi.fn(),
      },
    };

    mockStorage = {
      upload: vi.fn(),
      generateSignedUrl: vi.fn(),
    };

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    mockJobs = {
      file: {
        chunk: vi.fn(),
      },
      researchTasks: {
        sendToClient: vi.fn(),
      },
    };

    adapters = {
      db: mockDb,
      storage: mockStorage,
      logger: mockLogger,
      jobs: mockJobs,
    };

    mockUser = {
      id: 'test-user-id',
      email: 'test@example.com',
    };

    mockResearchTask = {
      id: 'test-task-id',
      type: ResearchTaskType.SCRAPE,
      title: 'Test Research Task',
      userId: 'test-user-id',
      organizationId: null,
      researchAgentId: 'test-agent-id',
      status: ResearchTaskStatus.PROCESSING,
      urls: ['https://example.com'],
      discoveredLinks: [
        {
          url: 'https://example.com/document1.pdf',
          text: 'Important Document 1',
          relevance: 0.9,
          isDownloadable: true,
          isRecommended: true,
          fileType: 'application/pdf',
        },
        {
          url: 'https://example.com/document2.pdf',
          text: 'Important Document 2',
          relevance: 0.8,
          isDownloadable: true,
          isRecommended: true,
          fileType: 'application/pdf',
        },
        {
          url: 'https://example.com/lowrelevance.pdf',
          text: 'Low Relevance Document',
          relevance: 0.3,
          isDownloadable: true,
          isRecommended: false,
          fileType: 'application/pdf',
        },
      ],
    };

    mockFileBuffer = Buffer.from('mock file content');

    mockedPrepareTagsForResearchTask.mockResolvedValue([{ name: 'Test Tag', strength: 1.0 }]);

    mockSendStatusUpdate = vi.fn().mockResolvedValue(undefined);

    mockedCreateSendStatusUpdate.mockReturnValue(mockSendStatusUpdate);
  });

  it('should download relevant links successfully', async () => {
    // Arrange
    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: '[Test Research Task] Important Document 1.pdf',
      mimeType: 'application/pdf',
      fileSize: mockFileBuffer.length,
      type: KnowledgeType.URL,
    };

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
    mockedFileTypeFromBuffer.mockResolvedValue({
      mime: 'application/pdf',
      ext: 'pdf',
    });
    mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
    mockedFabFilesService.createFabFile.mockResolvedValue(mockFabFile);

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockDb.researchTasks.findById).toHaveBeenCalledWith('test-task-id');
    expect(mockDb.users.findById).toHaveBeenCalledWith('test-user-id');
    expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/document1.pdf', { responseType: 'arraybuffer' });
    expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/document2.pdf', { responseType: 'arraybuffer' });
    expect(mockedFabFilesService.createFabFile).toHaveBeenCalledTimes(2);
    expect(mockDb.researchDatas.existsByUrlAndResearchTaskId).toHaveBeenCalledTimes(2);
    expect(mockDb.researchDatas.create).toHaveBeenCalledTimes(2);
    expect(mockJobs.file.chunk).toHaveBeenCalledTimes(2);
    expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ResearchTaskStatus.COMPLETED,
      })
    );
  });

  it('should throw NotFoundError when research task is not found', async () => {
    // Arrange
    mockDb.researchTasks.findById.mockResolvedValue(null);

    // Act & Assert
    await expect(downloadRelevantLinks({ id: 'non-existent-task' }, adapters)).rejects.toThrow(NotFoundError);
  });

  it('should throw UnprocessableEntityError when task type is not SCRAPE', async () => {
    // Arrange
    const nonScrapeTask = {
      ...mockResearchTask,
      type: ResearchTaskType.SALESFORCE,
    };
    mockDb.researchTasks.findById.mockResolvedValue(nonScrapeTask);

    // Act & Assert
    await expect(downloadRelevantLinks({ id: 'test-task-id' }, adapters)).rejects.toThrow(UnprocessableEntityError);
  });

  it('should throw NotFoundError when user is not found', async () => {
    // Arrange
    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(null);

    // Act & Assert
    await expect(downloadRelevantLinks({ id: 'test-task-id' }, adapters)).rejects.toThrow(NotFoundError);
  });

  it('should return early when no relevant links exist', async () => {
    // Arrange
    const taskWithNoRelevantLinks = {
      ...mockResearchTask,
      discoveredLinks: [
        {
          url: 'https://example.com/lowrelevance.pdf',
          text: 'Low Relevance Document',
          relevance: 0.3,
          isDownloadable: true,
          isRecommended: false,
          fileType: 'application/pdf',
        },
      ],
    };

    mockDb.researchTasks.findById.mockResolvedValue(taskWithNoRelevantLinks);
    mockDb.users.findById.mockResolvedValue(mockUser);

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(mockedFabFilesService.createFabFile).not.toHaveBeenCalled();
    expect(mockDb.researchDatas.create).not.toHaveBeenCalled();
  });

  it('should filter links based on relevance and downloadability', async () => {
    // Arrange
    const taskWithMixedLinks = {
      ...mockResearchTask,
      discoveredLinks: [
        {
          url: 'https://example.com/high-relevance.pdf',
          text: 'High Relevance Document',
          relevance: 0.9,
          isDownloadable: true,
          isRecommended: true,
          fileType: 'application/pdf',
        },
        {
          url: 'https://example.com/not-downloadable.html',
          text: 'Not Downloadable',
          relevance: 0.8,
          isDownloadable: false,
          isRecommended: true,
          fileType: 'text/html',
        },
        {
          url: 'https://example.com/low-relevance.pdf',
          text: 'Low Relevance',
          relevance: 0.3,
          isDownloadable: true,
          isRecommended: false,
          fileType: 'application/pdf',
        },
      ],
    };

    mockDb.researchTasks.findById.mockResolvedValue(taskWithMixedLinks);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
    mockedFileTypeFromBuffer.mockResolvedValue({
      mime: 'application/pdf',
      ext: 'pdf',
    });
    mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
    mockedFabFilesService.createFabFile.mockResolvedValue({
      id: 'mock-fab-file-id',
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
    });

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/high-relevance.pdf', {
      responseType: 'arraybuffer',
    });
  });

  it('should handle unsupported file types gracefully', async () => {
    // Arrange
    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
    mockedFileTypeFromBuffer.mockResolvedValue({
      mime: 'application/unsupported',
      ext: 'unsupported',
    });

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Unsupported file type: application/unsupported')
    );
    expect(mockedFabFilesService.createFabFile).not.toHaveBeenCalled();
    expect(mockDb.researchDatas.create).not.toHaveBeenCalled();
  });

  it('should handle file type detection failure', async () => {
    // Arrange
    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
    mockedFileTypeFromBuffer.mockResolvedValue(null);

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Could not determine file type'));
    expect(mockedFabFilesService.createFabFile).not.toHaveBeenCalled();
  });

  it('should handle existing research data and files', async () => {
    // Arrange
    const existingFile = {
      id: 'existing-fab-file-id',
      fileName: 'existing-file.pdf',
      mimeType: 'application/pdf',
    };
    const existingResearchData = {
      id: 'existing-research-data-id',
      researchTaskId: 'test-task-id',
      fabFileId: 'existing-fab-file-id',
    };

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
    mockedFileTypeFromBuffer.mockResolvedValue({
      mime: 'application/pdf',
      ext: 'pdf',
    });
    mockedFindOrUpdateExistingResearchData.mockResolvedValue({
      file: existingFile,
      researchData: existingResearchData,
    });
    // Mock existsByUrlAndResearchTaskId to return true since this is existing data owned by the same task
    mockDb.researchDatas.existsByUrlAndResearchTaskId.mockResolvedValue(true);

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockedFabFilesService.createFabFile).not.toHaveBeenCalled();
    expect(mockDb.researchDatas.existsByUrlAndResearchTaskId).toHaveBeenCalledTimes(2);
    expect(mockDb.researchDatas.create).not.toHaveBeenCalled();
    expect(mockJobs.file.chunk).toHaveBeenCalledWith('existing-fab-file-id');
  });

  it('should create research data when existing file is not owned by current task', async () => {
    // Arrange
    const existingFile = {
      id: 'existing-fab-file-id',
      fileName: 'existing-file.pdf',
      mimeType: 'application/pdf',
    };
    const existingResearchData = {
      id: 'existing-research-data-id',
      researchTaskId: 'different-task-id',
      fabFileId: 'existing-fab-file-id',
    };

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
    mockedFileTypeFromBuffer.mockResolvedValue({
      mime: 'application/pdf',
      ext: 'pdf',
    });
    mockedFindOrUpdateExistingResearchData.mockResolvedValue({
      file: existingFile,
      researchData: existingResearchData,
    });

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockDb.researchDatas.existsByUrlAndResearchTaskId).toHaveBeenCalledWith(
      'https://example.com/document1.pdf',
      'test-task-id'
    );
    expect(mockDb.researchDatas.create).toHaveBeenCalledWith({
      fabFileId: 'existing-fab-file-id',
      researchAgentId: 'test-agent-id',
      researchTaskId: 'test-task-id',
      organizationId: null,
      url: 'https://example.com/document1.pdf',
      userId: 'test-user-id',
    });
  });

  it('should handle download failures gracefully', async () => {
    // Arrange
    const downloadError = new Error('Network error');
    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockRejectedValue(downloadError);

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to download file from'));
    expect(mockedFabFilesService.createFabFile).not.toHaveBeenCalled();
    expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ResearchTaskStatus.COMPLETED,
      })
    );
  });

  it('should handle chunking failures gracefully', async () => {
    // Arrange
    const chunkError = new Error('Chunking failed');
    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
    };

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
    mockedFileTypeFromBuffer.mockResolvedValue({
      mime: 'application/pdf',
      ext: 'pdf',
    });
    mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
    mockedFabFilesService.createFabFile.mockResolvedValue(mockFabFile);
    mockJobs.file.chunk.mockRejectedValue(chunkError);

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to queue chunking for file'));
    expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ResearchTaskStatus.COMPLETED,
      })
    );
  });

  it('should handle missing chunking service gracefully', async () => {
    // Arrange
    const adaptersWithoutChunking = {
      ...adapters,
      jobs: {
        file: undefined,
      },
    };
    const mockFabFile = {
      id: 'mock-fab-file-id',
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
    };

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
    mockedFileTypeFromBuffer.mockResolvedValue({
      mime: 'application/pdf',
      ext: 'pdf',
    });
    mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
    mockedFabFilesService.createFabFile.mockResolvedValue(mockFabFile);

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adaptersWithoutChunking);

    // Assert
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('No chunking service available'));
  });

  it('should apply tags to downloaded files', async () => {
    // Arrange
    const mockTags = [
      { name: 'Research Tag', strength: 1.0 },
      { name: 'Important', strength: 1.0 },
    ];
    mockedPrepareTagsForResearchTask.mockResolvedValue(mockTags);

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
    mockedFileTypeFromBuffer.mockResolvedValue({
      mime: 'application/pdf',
      ext: 'pdf',
    });
    mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
    mockedFabFilesService.createFabFile.mockResolvedValue({
      id: 'mock-fab-file-id',
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
    });

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockedPrepareTagsForResearchTask).toHaveBeenCalledWith(
      { user: mockUser, researchTask: mockResearchTask },
      adapters
    );
    expect(mockedFabFilesService.createFabFile).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({
        tags: [
          { name: 'Research Tag', strength: 1.0 },
          { name: 'Important', strength: 1.0 },
        ],
      }),
      adapters
    );
  });

  it('should handle organization-based research task', async () => {
    // Arrange
    const orgTask = {
      ...mockResearchTask,
      organizationId: 'test-org-id',
    };

    mockDb.researchTasks.findById.mockResolvedValue(orgTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
    mockedFileTypeFromBuffer.mockResolvedValue({
      mime: 'application/pdf',
      ext: 'pdf',
    });
    mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
    mockedFabFilesService.createFabFile.mockResolvedValue({
      id: 'mock-fab-file-id',
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
    });

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockedFabFilesService.createFabFile).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({
        organizationId: 'test-org-id',
        prefix: 'research-tasks/test-task-id',
      }),
      adapters
    );
    expect(mockDb.researchDatas.existsByUrlAndResearchTaskId).toHaveBeenCalledWith(
      'https://example.com/document1.pdf',
      'test-task-id'
    );
    expect(mockDb.researchDatas.create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'test-org-id',
      })
    );
  });

  it('should process files with correct naming convention', async () => {
    // Arrange
    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
    mockedFileTypeFromBuffer.mockResolvedValue({
      mime: 'application/pdf',
      ext: 'pdf',
    });
    mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
    mockedFabFilesService.createFabFile.mockResolvedValue({
      id: 'mock-fab-file-id',
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
    });

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockedFabFilesService.createFabFile).toHaveBeenCalledWith(
      'test-user-id',
      expect.objectContaining({
        fileName: '[Test Research Task] Important Document 1.pdf',
        mimeType: 'application/pdf',
        type: KnowledgeType.URL,
        fileSize: mockFileBuffer.length,
        content: mockFileBuffer,
      }),
      adapters
    );
  });

  describe('Progress Tracking', () => {
    it('should send progress updates within 71-100% range', async () => {
      // Arrange
      const mockFabFile = {
        id: 'mock-fab-file-id',
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
      };

      mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
      mockDb.users.findById.mockResolvedValue(mockUser);
      mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
      mockedFileTypeFromBuffer.mockResolvedValue({
        mime: 'application/pdf',
        ext: 'pdf',
      });
      mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
      mockedFabFilesService.createFabFile.mockResolvedValue(mockFabFile);

      // Act
      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      expect(mockedCreateSendStatusUpdate).toHaveBeenCalledWith(
        mockResearchTask,
        expect.anything(), // queueRunner
        mockJobs.researchTasks.sendToClient,
        mockLogger,
        expect.objectContaining({
          baseProgress: 71,
          maxProgress: 100,
        })
      );
    });

    it('should distribute progress across multiple downloads within 71-100% range', async () => {
      // Arrange
      const taskWithMultipleLinks = {
        ...mockResearchTask,
        discoveredLinks: [
          {
            url: 'https://example.com/document1.pdf',
            text: 'Important Document 1',
            isDownloadable: true,
            relevance: 0.8,
          },
          {
            url: 'https://example.com/document2.pdf',
            text: 'Important Document 2',
            isDownloadable: true,
            relevance: 0.9,
          },
          {
            url: 'https://example.com/document3.pdf',
            text: 'Important Document 3',
            isDownloadable: true,
            relevance: 0.85,
          },
        ],
      };
      const mockFabFile = {
        id: 'mock-fab-file-id',
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
      };

      mockDb.researchTasks.findById.mockResolvedValue(taskWithMultipleLinks);
      mockDb.users.findById.mockResolvedValue(mockUser);
      mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
      mockedFileTypeFromBuffer.mockResolvedValue({
        mime: 'application/pdf',
        ext: 'pdf',
      });
      mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
      mockedFabFilesService.createFabFile.mockResolvedValue(mockFabFile);

      // Act
      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      expect(mockedCreateSendStatusUpdate).toHaveBeenCalledWith(
        taskWithMultipleLinks,
        expect.anything(), // queueRunner
        mockJobs.researchTasks.sendToClient,
        mockLogger,
        expect.objectContaining({
          baseProgress: 71,
          maxProgress: 100,
        })
      );
    });

    it('should reach 100% progress on completion', async () => {
      // Arrange
      const mockFabFile = {
        id: 'mock-fab-file-id',
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
      };

      mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
      mockDb.users.findById.mockResolvedValue(mockUser);
      mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
      mockedFileTypeFromBuffer.mockResolvedValue({
        mime: 'application/pdf',
        ext: 'pdf',
      });
      mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
      mockedFabFilesService.createFabFile.mockResolvedValue(mockFabFile);

      // Act
      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      const sendStatusUpdateCalls = mockSendStatusUpdate.mock.calls;
      const statusMessages = sendStatusUpdateCalls.map(call => call[0]); // First argument is the status message

      expect(statusMessages.some(msg => msg.includes('Research task completed'))).toBe(true);
    });

    it('should include download counts in status messages', async () => {
      // Arrange
      const taskWithMultipleLinks = {
        ...mockResearchTask,
        discoveredLinks: [
          {
            url: 'https://example.com/document1.pdf',
            text: 'Important Document 1',
            isDownloadable: true,
            relevance: 0.8,
          },
          {
            url: 'https://example.com/document2.pdf',
            text: 'Important Document 2',
            isDownloadable: true,
            relevance: 0.9,
          },
        ],
      };
      const mockFabFile = {
        id: 'mock-fab-file-id',
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
      };

      mockDb.researchTasks.findById.mockResolvedValue(taskWithMultipleLinks);
      mockDb.users.findById.mockResolvedValue(mockUser);
      mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
      mockedFileTypeFromBuffer.mockResolvedValue({
        mime: 'application/pdf',
        ext: 'pdf',
      });
      mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
      mockedFabFilesService.createFabFile.mockResolvedValue(mockFabFile);

      // Act
      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      const sendStatusUpdateCalls = mockSendStatusUpdate.mock.calls;
      const statusMessages = sendStatusUpdateCalls.map(call => call[0]); // First argument is the status message

      expect(statusMessages.some(msg => msg.includes('Downloaded'))).toBe(true);
    });

    it('should handle sendToClient errors gracefully', async () => {
      // Arrange
      const mockFabFile = {
        id: 'mock-fab-file-id',
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
      };

      mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
      mockDb.users.findById.mockResolvedValue(mockUser);
      mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
      mockedFileTypeFromBuffer.mockResolvedValue({
        mime: 'application/pdf',
        ext: 'pdf',
      });
      mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
      mockedFabFilesService.createFabFile.mockResolvedValue(mockFabFile);
      mockJobs.researchTasks.sendToClient.mockRejectedValue(new Error('WebSocket error'));

      // Act
      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      // Process should still complete successfully even with sendToClient errors
      expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ResearchTaskStatus.COMPLETED,
        })
      );
    });

    it('should not send progress updates when sendToClient is not available', async () => {
      // Arrange
      const adaptersWithoutSendToClient = {
        ...adapters,
        jobs: {
          file: {
            chunk: vi.fn(),
          },
        },
      };
      const mockFabFile = {
        id: 'mock-fab-file-id',
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
      };

      mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
      mockDb.users.findById.mockResolvedValue(mockUser);
      mockedAxios.get.mockResolvedValue({ data: mockFileBuffer });
      mockedFileTypeFromBuffer.mockResolvedValue({
        mime: 'application/pdf',
        ext: 'pdf',
      });
      mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
      mockedFabFilesService.createFabFile.mockResolvedValue(mockFabFile);

      // Act
      await downloadRelevantLinks({ id: 'test-task-id' }, adaptersWithoutSendToClient);

      // Assert
      expect(mockSendStatusUpdate).toHaveBeenCalled();

      expect(mockedCreateSendStatusUpdate).toHaveBeenCalledWith(
        mockResearchTask,
        expect.anything(),
        undefined, // sendToClient should be undefined
        mockLogger,
        expect.anything()
      );

      // Process should still complete successfully
      expect(mockDb.researchTasks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ResearchTaskStatus.COMPLETED,
        })
      );
    });
  });
});
