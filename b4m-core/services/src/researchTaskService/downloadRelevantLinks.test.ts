import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  downloadRelevantLinks,
  MAX_LINKS_PER_RESEARCH_TASK,
  MAX_DOWNLOAD_BYTES_PER_RESEARCH_TASK,
  MAX_LINK_DOWNLOAD_BYTES,
} from './downloadRelevantLinks';
import { NotFoundError, UnprocessableEntityError } from '@bike4mind/utils';
import { ResearchTaskType, ResearchTaskStatus, KnowledgeType } from '@bike4mind/common';
import { ssrfSafeDownload } from '@bike4mind/fab-pipeline';
import { fileTypeFromBuffer } from 'file-type';
import * as fabFilesService from '../fabFileService';
import { findOrUpdateExistingResearchData, prepareTagsForResearchTask, createSendStatusUpdate } from './utils';

vi.mock('@bike4mind/fab-pipeline', () => ({ ssrfSafeDownload: vi.fn() }));
vi.mock('file-type');
vi.mock('../fabFileService', () => ({ createFabFile: vi.fn() }));
vi.mock('./utils', () => ({
  findOrUpdateExistingResearchData: vi.fn(),
  prepareTagsForResearchTask: vi.fn(),
  createSendStatusUpdate: vi.fn(),
}));

const mockedDownload = vi.mocked(ssrfSafeDownload);
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
        addWarning: vi.fn(),
      },
      researchDatas: {
        create: vi.fn(),
        update: vi.fn(),
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
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
    expect(mockedDownload).toHaveBeenCalledWith(
      'https://example.com/document1.pdf',
      expect.objectContaining({ maxBytes: expect.any(Number), timeoutMs: expect.any(Number) })
    );
    expect(mockedDownload).toHaveBeenCalledWith(
      'https://example.com/document2.pdf',
      expect.objectContaining({ maxBytes: expect.any(Number), timeoutMs: expect.any(Number) })
    );
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
    expect(mockedDownload).not.toHaveBeenCalled();
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
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
    expect(mockedDownload).toHaveBeenCalledTimes(1);
    expect(mockedDownload).toHaveBeenCalledWith(
      'https://example.com/high-relevance.pdf',
      expect.objectContaining({ maxBytes: expect.any(Number), timeoutMs: expect.any(Number) })
    );
  });

  it('should handle unsupported file types gracefully', async () => {
    // Arrange
    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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

  it('tells the user when a re-downloaded link keeps the previous copy because storage is full', async () => {
    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
    mockedFileTypeFromBuffer.mockResolvedValue({ mime: 'application/pdf', ext: 'pdf' });
    mockedFindOrUpdateExistingResearchData.mockResolvedValue({
      file: { id: 'existing-fab-file-id', fileName: 'existing-file.pdf', mimeType: 'application/pdf' },
      researchData: { id: 'existing-research-data-id', researchTaskId: 'test-task-id' },
      storageLimitReached: true,
    });
    mockDb.researchDatas.existsByUrlAndResearchTaskId.mockResolvedValue(true);

    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    expect(mockSendStatusUpdate).toHaveBeenCalledWith(
      '⚠️ Storage limit reached: kept the previous copy of Important Document 1',
      0
    );
    expect(mockDb.researchTasks.addWarning).toHaveBeenCalledWith(
      'test-task-id',
      'Storage limit reached: kept the previous copy of https://example.com/document1.pdf'
    );
    expect(mockSendStatusUpdate).toHaveBeenCalledWith(
      '\u{1F389} Research task completed with 0 files downloaded, 2 kept their previous copy (storage limit reached)',
      100
    );
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
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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

  it('creates a fresh file and relinks the research data when the linked file has another owner', async () => {
    const freshFile = { id: 'fresh-file-id', fileName: 'fresh.pdf', mimeType: 'application/pdf' };
    const legacyResearchData = { id: 'legacy-rd-id', researchTaskId: 'test-task-id', fabFileId: 'foreign-file-id' };

    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
    mockedFileTypeFromBuffer.mockResolvedValue({ mime: 'application/pdf', ext: 'pdf' });
    mockedFindOrUpdateExistingResearchData.mockResolvedValue({
      file: null,
      researchData: legacyResearchData,
      storageLimitReached: false,
    });
    mockedFabFilesService.createFabFile.mockResolvedValue(freshFile);

    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    expect(mockedFabFilesService.createFabFile).toHaveBeenCalledWith(
      'test-user-id',
      expect.anything(),
      expect.anything()
    );
    expect(mockDb.researchDatas.update).toHaveBeenCalledWith({ id: 'legacy-rd-id', fabFileId: 'fresh-file-id' });
  });

  it('should handle download failures gracefully', async () => {
    // Arrange
    const downloadError = new Error('Network error');
    mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedDownload.mockRejectedValue(downloadError);

    // Act
    await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

    // Assert
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to download file from'));
    expect(mockedFabFilesService.createFabFile).not.toHaveBeenCalled();
    // The status update names the link but not the failure detail: a guard message can carry the
    // private address a hostname resolved to, which belongs in the log, not in the task owner's UI.
    const statusTexts = mockSendStatusUpdate.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(statusTexts).toContain('❌ Download failed: Important Document 1');
    expect(statusTexts.some(text => text.includes(downloadError.message))).toBe(false);
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
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
      // Narrowed to {db, storage} - createFabFile never sees this door's `jobs`/`logger` adapters.
      { db: adapters.db, storage: adapters.storage }
    );
  });

  it('should not forward the task organizationId to createFabFile (the owner derives from the lake)', async () => {
    // Arrange
    const orgTask = {
      ...mockResearchTask,
      organizationId: 'test-org-id',
    };

    mockDb.researchTasks.findById.mockResolvedValue(orgTask);
    mockDb.users.findById.mockResolvedValue(mockUser);
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
        prefix: 'research-tasks/test-task-id',
      }),
      // Narrowed to {db, storage} - createFabFile never sees this door's `jobs`/`logger` adapters.
      { db: adapters.db, storage: adapters.storage }
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
    mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
      // Narrowed to {db, storage} - createFabFile never sees this door's `jobs`/`logger` adapters.
      { db: adapters.db, storage: adapters.storage }
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
      mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
      mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
      mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
      mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
      mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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
      mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });
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

  describe('per-task download limits', () => {
    const MAX_FILE = MAX_LINK_DOWNLOAD_BYTES;
    const MiB = 1024 * 1024;

    const makeLinks = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        url: `https://example.com/doc${i}.pdf`,
        text: `Doc ${i}`,
        relevance: 0.71 + i * 0.001,
        isDownloadable: true,
        isRecommended: true,
        fileType: 'application/pdf',
      }));

    // Small real buffer that reports a large length, so no big allocation is needed.
    const bigBuffer = (size: number) => Object.defineProperty(Buffer.from('x'), 'length', { value: size });

    const setup = (links: unknown[]) => {
      mockResearchTask.discoveredLinks = links;
      mockDb.researchTasks.findById.mockResolvedValue(mockResearchTask);
      mockDb.users.findById.mockResolvedValue(mockUser);
      mockedFileTypeFromBuffer.mockResolvedValue({ mime: 'application/pdf', ext: 'pdf' });
      mockedFindOrUpdateExistingResearchData.mockResolvedValue(null);
      mockedFabFilesService.createFabFile.mockResolvedValue({ id: 'f', mimeType: 'application/pdf' });
    };

    it('keeps only the highest-relevance links when over the count cap', async () => {
      const links = makeLinks(MAX_LINKS_PER_RESEARCH_TASK + 5);
      setup([...links].sort((a, b) => (a.url < b.url ? 1 : -1))); // shuffled vs relevance order
      mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });

      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      const expected = links
        .slice(5)
        .map(l => l.url)
        .sort();
      const called = mockedDownload.mock.calls.map(c => c[0]).sort();
      expect(called).toEqual(expected);
      expect(mockDb.researchTasks.addWarning).not.toHaveBeenCalled();
    });

    it('starts with the highest-relevance links', async () => {
      const links = makeLinks(6);
      setup(links);
      mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });

      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      expect(mockedDownload.mock.calls.slice(0, 3).map(c => c[0])).toEqual([links[5].url, links[4].url, links[3].url]);
    });

    it('stops downloading once the byte budget is spent and warns once', async () => {
      const links = makeLinks(10);
      setup(links);
      mockedDownload.mockImplementation(async (_url, opts) => ({
        data: bigBuffer(opts?.maxBytes ?? 0),
        contentType: undefined,
        finalUrl: '',
      }));

      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      // 250 MiB budget at 50 MiB per file: 5 downloads, the rest skipped.
      const fullFiles = Math.floor(MAX_DOWNLOAD_BYTES_PER_RESEARCH_TASK / MAX_FILE);
      expect(mockedDownload).toHaveBeenCalledTimes(fullFiles);
      expect(mockedDownload.mock.calls.map(c => c[0]).sort()).toEqual(
        links
          .slice(-fullFiles)
          .map(l => l.url)
          .sort()
      );
      expect(mockDb.researchTasks.addWarning).toHaveBeenCalledTimes(1);
      expect(mockDb.researchTasks.addWarning).toHaveBeenCalledWith(
        'test-task-id',
        expect.stringContaining(`skipped ${10 - fullFiles} links`)
      );
      expect(mockSendStatusUpdate).toHaveBeenCalledWith(expect.stringContaining('download budget reached'), 100);
    });

    it('caps maxBytes at the remaining budget for the last link', async () => {
      const fullFiles = Math.floor(MAX_DOWNLOAD_BYTES_PER_RESEARCH_TASK / MAX_FILE);
      const links = makeLinks(fullFiles + 1);
      setup(links);
      // Each file takes 49 MiB, leaving the budget short of a full reserve for the last link.
      mockedDownload.mockImplementation(async () => ({
        data: bigBuffer(MAX_FILE - 1024 * 1024),
        contentType: undefined,
        finalUrl: '',
      }));
      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      const maxes = mockedDownload.mock.calls.map(c => c[1]?.maxBytes as number);
      // Five files of 49 MiB leave exactly the rest of the budget for the last link.
      const lastReserve = MAX_DOWNLOAD_BYTES_PER_RESEARCH_TASK - fullFiles * (MAX_FILE - MiB);
      expect(maxes).toEqual([...Array(fullFiles).fill(MAX_FILE), lastReserve]);
    });

    it('does not reuse bytes of a download that succeeded before a later step threw', async () => {
      const fullFiles = Math.floor(MAX_DOWNLOAD_BYTES_PER_RESEARCH_TASK / MAX_FILE);
      setup(makeLinks(fullFiles + 1));
      mockedDownload.mockImplementation(async (_url, opts) => ({
        data: bigBuffer(opts?.maxBytes ?? 0),
        contentType: undefined,
        finalUrl: '',
      }));
      mockedFabFilesService.createFabFile.mockRejectedValueOnce(new Error('storage down'));

      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      // The failed link already downloaded its bytes, so they stay spent.
      expect(mockedDownload).toHaveBeenCalledTimes(fullFiles);
      expect(mockDb.researchTasks.addWarning).toHaveBeenCalledWith(
        'test-task-id',
        expect.stringContaining('skipped 1 links')
      );
    });

    it('downloads the remaining small links when slow downloads only reserved the budget', async () => {
      const links = makeLinks(25); // download order: doc24 (highest relevance) first
      setup(links);
      const slow = new Map<string, () => void>();
      mockedDownload.mockImplementation(async url => {
        const index = Number(/doc(\d+)/.exec(url)?.[1]);
        const rank = 24 - index; // 0 = first started
        if (rank < 3) return { data: bigBuffer(MAX_FILE), contentType: undefined, finalUrl: '' };
        if (rank < 5) {
          await new Promise<void>(resolve => slow.set(url, resolve));
          return { data: bigBuffer(1024), contentType: undefined, finalUrl: '' };
        }
        return { data: bigBuffer(1024), contentType: undefined, finalUrl: '' };
      });

      const done = downloadRelevantLinks({ id: 'test-task-id' }, adapters);
      await vi.waitFor(() => expect(slow.size).toBe(2));
      // Queued links must wait for the two reservations instead of being skipped.
      expect(mockedDownload).toHaveBeenCalledTimes(5);
      slow.forEach(release => release());
      await done;

      expect(mockedDownload).toHaveBeenCalledTimes(25);
      expect(mockDb.researchTasks.addWarning).not.toHaveBeenCalled();
    });

    it('still skips a link when the budget is spent and nothing is in flight', async () => {
      const fullFiles = Math.floor(MAX_DOWNLOAD_BYTES_PER_RESEARCH_TASK / MAX_FILE);
      setup(makeLinks(fullFiles + 1));
      mockedDownload.mockImplementation(async (_url, opts) => ({
        data: bigBuffer(opts?.maxBytes ?? 0),
        contentType: undefined,
        finalUrl: '',
      }));

      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      expect(mockedDownload).toHaveBeenCalledTimes(fullFiles);
      expect(mockDb.researchTasks.addWarning).toHaveBeenCalledTimes(1);
    });

    it('refunds the reservation when a download fails', async () => {
      const fullFiles = Math.floor(MAX_DOWNLOAD_BYTES_PER_RESEARCH_TASK / MAX_FILE);
      const links = makeLinks(fullFiles + 1);
      setup(links);
      let first = true;
      mockedDownload.mockImplementation(async () => {
        if (first) {
          first = false;
          throw new Error('boom');
        }
        return { data: bigBuffer(MAX_FILE), contentType: undefined, finalUrl: '' };
      });

      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      // The failed link kept no bytes, so every link still gets a full-size reservation.
      expect(mockedDownload).toHaveBeenCalledTimes(fullFiles + 1);
      expect(mockedDownload.mock.calls.every(c => c[1]?.maxBytes === MAX_FILE)).toBe(true);
      expect(mockDb.researchTasks.addWarning).not.toHaveBeenCalled();
    });

    it('does not warn or change maxBytes under the limits', async () => {
      setup(makeLinks(2));
      mockedDownload.mockResolvedValue({ data: mockFileBuffer, contentType: undefined, finalUrl: '' });

      await downloadRelevantLinks({ id: 'test-task-id' }, adapters);

      expect(mockedDownload).toHaveBeenCalledTimes(2);
      expect(mockedDownload.mock.calls.every(c => c[1]?.maxBytes === MAX_FILE)).toBe(true);
      expect(mockDb.researchTasks.addWarning).not.toHaveBeenCalled();
    });
  });
});
