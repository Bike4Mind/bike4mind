import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import {
  findExistingResearchData,
  findOrUpdateExistingResearchData,
  hasOrganizationContext,
  getResearchDataScope,
  createSendStatusUpdate,
} from './utils';
import {
  IResearchData,
  IResearchTaskScrape,
  IUserDocument,
  ResearchTaskType,
  ResearchTaskExecutionType,
  ResearchTaskStatus,
} from '@bike4mind/common';

describe('findExistingResearchData utils', () => {
  const mockUser: IUserDocument = {
    id: 'test-user-123',
    email: 'test@example.com',
    name: 'Test User',
  } as IUserDocument;

  const mockResearchTaskWithOrganization: IResearchTaskScrape = {
    id: 'task-123',
    userId: 'test-user-123',
    researchAgentId: 'agent-123',
    organizationId: 'org-123',
    title: 'Test Task',
    description: 'Test Description',
    type: ResearchTaskType.SCRAPE,
    executionType: ResearchTaskExecutionType.ON_DEMAND,
    status: ResearchTaskStatus.PENDING,
    urls: ['https://example.com'],
    canDiscoverLinks: true,
    discoveredLinks: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockResearchTaskWithoutOrganization: IResearchTaskScrape = {
    ...mockResearchTaskWithOrganization,
    organizationId: undefined,
  };

  const mockResearchData: IResearchData = {
    id: 'research-data-123',
    researchTaskId: 'task-123',
    researchAgentId: 'agent-123',
    fabFileId: 'file-123',
    organizationId: 'org-123',
    metaData: { url: 'https://example.com' },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockFabFile = {
    id: 'file-123',
    filePath: 'test/path/file.md',
    fileName: 'test-file.md',
    fileSize: 1024,
    mimeType: 'text/markdown',
    // Research content is non-image, so objectCreated resolves it to 'clean' immediately on
    // upload; a re-crawl therefore always sees a scanned file. The serve gate fail-closes on
    // ALL mime types until 'clean', so the fixture must carry it to re-mint.
    moderationStatus: 'clean',
    fileUrl: 'https://s3.example.com/signed-url',
    fileUrlExpireAt: new Date(Date.now() + 3600000),
    updatedAt: new Date(),
  };

  let mockResearchDataRepo: any;
  let mockFabFilesRepo: any;
  let mockStorage: any;
  let mockLogger: { info: Mock; error: Mock };
  let adapters: any;

  beforeEach(() => {
    mockResearchDataRepo = {
      findByMetadataUrlAndOrganizationId: vi.fn(),
      findByMetadataUrlAndUserId: vi.fn(),
      findByUrlAndOrganizationId: vi.fn(),
      findByUrlAndUserId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      findAll: vi.fn(),
      delete: vi.fn(),
      findAllByResearchTaskId: vi.fn(),
      findAllByResearchAgentId: vi.fn(),
      deleteAllByResearchTaskId: vi.fn(),
      deleteByFabFileId: vi.fn(),
      findByResearchAgentIdAndResearchTaskId: vi.fn(),
      findAllByResearchTaskIdWithFiles: vi.fn(),
      findByIdAndResearchAgentId: vi.fn(),
    };

    mockFabFilesRepo = {
      findById: vi.fn(),
      update: vi.fn(),
    };

    mockStorage = {
      upload: vi.fn(),
      generateSignedUrl: vi.fn(),
    };

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    adapters = {
      db: {
        researchDatas: mockResearchDataRepo,
        fabFiles: mockFabFilesRepo,
      },
      storage: mockStorage,
    };

    vi.clearAllMocks();
  });

  describe('findExistingResearchData', () => {
    it('should use organization-based lookup when organizationId exists', async () => {
      // Arrange
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);

      // Act
      const result = await findExistingResearchData(
        'https://example.com',
        mockResearchTaskWithOrganization,
        mockUser,
        mockResearchDataRepo
      );

      // Assert
      expect(mockResearchDataRepo.findByUrlAndOrganizationId).toHaveBeenCalledWith('https://example.com', 'org-123');
      expect(mockResearchDataRepo.findByUrlAndUserId).not.toHaveBeenCalled();
      expect(result).toEqual(mockResearchData);
    });

    it('should use user-based lookup when organizationId does not exist', async () => {
      // Arrange
      mockResearchDataRepo.findByUrlAndUserId.mockResolvedValue(mockResearchData);

      // Act
      const result = await findExistingResearchData(
        'https://example.com',
        mockResearchTaskWithoutOrganization,
        mockUser,
        mockResearchDataRepo
      );

      // Assert
      expect(mockResearchDataRepo.findByUrlAndUserId).toHaveBeenCalledWith('https://example.com', 'test-user-123');
      expect(mockResearchDataRepo.findByUrlAndOrganizationId).not.toHaveBeenCalled();
      expect(result).toEqual(mockResearchData);
    });

    it('should return null when no existing research data is found', async () => {
      // Arrange
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(null);

      // Act
      const result = await findExistingResearchData(
        'https://example.com',
        mockResearchTaskWithOrganization,
        mockUser,
        mockResearchDataRepo
      );

      // Assert
      expect(result).toBeNull();
    });

    it('should handle empty organizationId as falsy', async () => {
      // Arrange
      const taskWithEmptyOrg = { ...mockResearchTaskWithOrganization, organizationId: '' };
      mockResearchDataRepo.findByUrlAndUserId.mockResolvedValue(mockResearchData);

      // Act
      const result = await findExistingResearchData(
        'https://example.com',
        taskWithEmptyOrg,
        mockUser,
        mockResearchDataRepo
      );

      // Assert
      expect(mockResearchDataRepo.findByUrlAndUserId).toHaveBeenCalledWith('https://example.com', 'test-user-123');
      expect(result).toEqual(mockResearchData);
    });
  });

  describe('findOrUpdateExistingResearchData', () => {
    beforeEach(() => {
      mockStorage.generateSignedUrl.mockResolvedValue('https://s3.example.com/new-signed-url');
    });

    it('should update existing file when research data exists', async () => {
      // Arrange
      const content = 'Updated content';
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
      mockFabFilesRepo.findById.mockResolvedValue(mockFabFile);

      // Act
      const result = await findOrUpdateExistingResearchData(
        'https://example.com',
        content,
        'text/markdown',
        mockResearchTaskWithOrganization,
        mockUser,
        adapters,
        mockLogger
      );

      // Assert
      expect(result).not.toBeNull();
      expect(result!.file).toEqual(mockFabFile);
      expect(result!.researchData).toEqual(mockResearchData);
      expect(mockStorage.upload).toHaveBeenCalledWith('test/path/file.md', content, {
        ContentType: 'text/markdown',
        ContentLength: Buffer.byteLength(content, 'utf8'),
      });
      expect(mockStorage.generateSignedUrl).toHaveBeenCalledWith(
        'test/path/file.md',
        432000, // 5 days in seconds
        'get'
      );
      expect(mockFabFilesRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          fileUrl: 'https://s3.example.com/new-signed-url',
          updatedAt: expect.any(Date),
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        '🗃️ [RESEARCH_DATA_EXISTS] Research data already exists for https://example.com'
      );
    });

    it('should handle Buffer content correctly', async () => {
      // Arrange
      const content = Buffer.from('Buffer content');
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
      mockFabFilesRepo.findById.mockResolvedValue(mockFabFile);

      // Act
      const result = await findOrUpdateExistingResearchData(
        'https://example.com',
        content,
        'application/pdf',
        mockResearchTaskWithOrganization,
        mockUser,
        adapters,
        mockLogger
      );

      // Assert
      expect(result).not.toBeNull();
      expect(mockStorage.upload).toHaveBeenCalledWith('test/path/file.md', content, {
        ContentType: 'application/pdf',
        ContentLength: content.length,
      });
    });

    it('should throw error when existing file is not found', async () => {
      // Arrange
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
      mockFabFilesRepo.findById.mockResolvedValue(null);

      // Act & Assert
      await expect(
        findOrUpdateExistingResearchData(
          'https://example.com',
          'content',
          'text/markdown',
          mockResearchTaskWithOrganization,
          mockUser,
          adapters,
          mockLogger
        )
      ).rejects.toThrow('Existing file not found');
    });

    it('should throw error when existing file has no filePath', async () => {
      // Arrange
      const fileWithoutPath = { ...mockFabFile, filePath: null };
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
      mockFabFilesRepo.findById.mockResolvedValue(fileWithoutPath);

      // Act & Assert
      await expect(
        findOrUpdateExistingResearchData(
          'https://example.com',
          'content',
          'text/markdown',
          mockResearchTaskWithOrganization,
          mockUser,
          adapters,
          mockLogger
        )
      ).rejects.toThrow('Existing file not found');
    });

    it('should return isExisting false when no research data exists', async () => {
      // Arrange
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(null);

      // Act
      const result = await findOrUpdateExistingResearchData(
        'https://example.com',
        'content',
        'text/markdown',
        mockResearchTaskWithOrganization,
        mockUser,
        adapters,
        mockLogger
      );

      // Assert
      expect(result).toBeNull();
      expect(mockStorage.upload).not.toHaveBeenCalled();
    });

    it('should work without logger', async () => {
      // Arrange
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(null);

      // Act
      const result = await findOrUpdateExistingResearchData(
        'https://example.com',
        'content',
        'text/markdown',
        mockResearchTaskWithOrganization,
        mockUser,
        adapters
        // No logger provided
      );

      // Assert
      expect(result).toBeNull();
      // Should not throw error when logger is undefined
    });

    it('should use user-based lookup when no organization', async () => {
      // Arrange
      mockResearchDataRepo.findByUrlAndUserId.mockResolvedValue(mockResearchData);
      mockFabFilesRepo.findById.mockResolvedValue(mockFabFile);

      // Act
      const result = await findOrUpdateExistingResearchData(
        'https://example.com',
        'content',
        'text/markdown',
        mockResearchTaskWithoutOrganization,
        mockUser,
        adapters,
        mockLogger
      );

      // Assert
      expect(mockResearchDataRepo.findByUrlAndUserId).toHaveBeenCalledWith('https://example.com', 'test-user-123');
      expect(result).not.toBeNull();
    });

    describe('#9776 Q2b — upload moderation gate on re-crawl', () => {
      it('does not re-mint or persist a fileUrl for a blocked image on re-crawl', async () => {
        // Arrange
        const blockedImageFile = {
          ...mockFabFile,
          mimeType: 'image/png',
          moderationStatus: 'blocked',
        };
        mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
        mockFabFilesRepo.findById.mockResolvedValue(blockedImageFile);

        // Act
        const result = await findOrUpdateExistingResearchData(
          'https://example.com',
          'content',
          'image/png',
          mockResearchTaskWithOrganization,
          mockUser,
          adapters,
          mockLogger
        );

        // Assert
        expect(mockStorage.generateSignedUrl).not.toHaveBeenCalled();
        expect(result!.file.fileUrl).toBeUndefined();
        expect(result!.file.fileUrlExpireAt).toBeUndefined();
        expect(mockFabFilesRepo.update).toHaveBeenCalledWith(
          expect.objectContaining({ fileUrl: undefined, fileUrlExpireAt: undefined })
        );
      });

      it('does not re-mint or persist a fileUrl for a still-pending image on re-crawl', async () => {
        // Arrange
        const pendingImageFile = {
          ...mockFabFile,
          mimeType: 'image/jpeg',
          moderationStatus: 'pending',
        };
        mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
        mockFabFilesRepo.findById.mockResolvedValue(pendingImageFile);

        // Act
        const result = await findOrUpdateExistingResearchData(
          'https://example.com',
          'content',
          'image/jpeg',
          mockResearchTaskWithOrganization,
          mockUser,
          adapters,
          mockLogger
        );

        // Assert
        expect(mockStorage.generateSignedUrl).not.toHaveBeenCalled();
        expect(result!.file.fileUrl).toBeUndefined();
      });

      it('still re-mints and persists a fileUrl for a clean image on re-crawl (unaffected)', async () => {
        // Arrange
        const cleanImageFile = {
          ...mockFabFile,
          mimeType: 'image/png',
          moderationStatus: 'clean',
        };
        mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
        mockFabFilesRepo.findById.mockResolvedValue(cleanImageFile);

        // Act
        const result = await findOrUpdateExistingResearchData(
          'https://example.com',
          'content',
          'image/png',
          mockResearchTaskWithOrganization,
          mockUser,
          adapters,
          mockLogger
        );

        // Assert
        expect(mockStorage.generateSignedUrl).toHaveBeenCalledWith('test/path/file.md', 432000, 'get');
        expect(result!.file.fileUrl).toBe('https://s3.example.com/new-signed-url');
      });

      it('re-mints a fileUrl for a clean non-image on re-crawl (normal case)', async () => {
        // Arrange - a clean text/markdown file (the production steady state for research content).
        mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
        mockFabFilesRepo.findById.mockResolvedValue({ ...mockFabFile, moderationStatus: 'clean' });

        // Act
        const result = await findOrUpdateExistingResearchData(
          'https://example.com',
          'content',
          'text/markdown',
          mockResearchTaskWithOrganization,
          mockUser,
          adapters,
          mockLogger
        );

        // Assert
        expect(mockStorage.generateSignedUrl).toHaveBeenCalledWith('test/path/file.md', 432000, 'get');
        expect(result!.file.fileUrl).toBe('https://s3.example.com/new-signed-url');
      });

      it('does not re-mint a fileUrl for a non-clean non-image on re-crawl (P1-1 fail-closed on ALL mime types)', async () => {
        // Arrange - the serve gate keys on moderationStatus alone, for every mime type. A
        // non-image that is not yet 'clean' (e.g. still pending its objectCreated pass, or a
        // legacy row before the backfill) must be withheld too, not just images.
        mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
        mockFabFilesRepo.findById.mockResolvedValue({ ...mockFabFile, moderationStatus: 'pending' });

        // Act
        const result = await findOrUpdateExistingResearchData(
          'https://example.com',
          'content',
          'text/markdown',
          mockResearchTaskWithOrganization,
          mockUser,
          adapters,
          mockLogger
        );

        // Assert - no URL minted, and any stale URL is cleared.
        expect(mockStorage.generateSignedUrl).not.toHaveBeenCalled();
        expect(result!.file.fileUrl).toBeUndefined();
        expect(result!.file.fileUrlExpireAt).toBeUndefined();
        expect(mockFabFilesRepo.update).toHaveBeenCalledWith(
          expect.objectContaining({ fileUrl: undefined, fileUrlExpireAt: undefined })
        );
      });
    });
  });

  describe('hasOrganizationContext', () => {
    it('should return true when organizationId exists', () => {
      // Act
      const result = hasOrganizationContext(mockResearchTaskWithOrganization);

      // Assert
      expect(result).toBe(true);
    });

    it('should return false when organizationId is undefined', () => {
      // Act
      const result = hasOrganizationContext(mockResearchTaskWithoutOrganization);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when organizationId is empty string', () => {
      // Arrange
      const taskWithEmptyOrg = { ...mockResearchTaskWithOrganization, organizationId: '' };

      // Act
      const result = hasOrganizationContext(taskWithEmptyOrg);

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when organizationId is null', () => {
      // Arrange
      const taskWithNullOrg = { ...mockResearchTaskWithOrganization, organizationId: null };

      // Act
      const result = hasOrganizationContext(taskWithNullOrg as any);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('getResearchDataScope', () => {
    it('should return organization scope when organizationId exists', () => {
      // Act
      const result = getResearchDataScope(mockResearchTaskWithOrganization, mockUser);

      // Assert
      expect(result).toEqual({
        scope: 'organization',
        id: 'org-123',
      });
    });

    it('should return user scope when organizationId does not exist', () => {
      // Act
      const result = getResearchDataScope(mockResearchTaskWithoutOrganization, mockUser);

      // Assert
      expect(result).toEqual({
        scope: 'user',
        id: 'test-user-123',
      });
    });

    it('should return user scope when organizationId is empty string', () => {
      // Arrange
      const taskWithEmptyOrg = { ...mockResearchTaskWithOrganization, organizationId: '' };

      // Act
      const result = getResearchDataScope(taskWithEmptyOrg, mockUser);

      // Assert
      expect(result).toEqual({
        scope: 'user',
        id: 'test-user-123',
      });
    });

    it('should return user scope when organizationId is null', () => {
      // Arrange
      const taskWithNullOrg = { ...mockResearchTaskWithOrganization, organizationId: null };

      // Act
      const result = getResearchDataScope(taskWithNullOrg as any, mockUser);

      // Assert
      expect(result).toEqual({
        scope: 'user',
        id: 'test-user-123',
      });
    });
  });

  describe('integration scenarios', () => {
    it('should handle complex organization-first workflow', async () => {
      // Arrange
      const url = 'https://complex-example.com';
      const content = 'Complex content';
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
      mockFabFilesRepo.findById.mockResolvedValue(mockFabFile);

      // Act
      const scope = getResearchDataScope(mockResearchTaskWithOrganization, mockUser);
      const hasOrgContext = hasOrganizationContext(mockResearchTaskWithOrganization);
      const existingData = await findExistingResearchData(
        url,
        mockResearchTaskWithOrganization,
        mockUser,
        mockResearchDataRepo
      );
      const updateResult = await findOrUpdateExistingResearchData(
        url,
        content,
        'text/markdown',
        mockResearchTaskWithOrganization,
        mockUser,
        adapters,
        mockLogger
      );

      // Assert
      expect(scope.scope).toBe('organization');
      expect(hasOrgContext).toBe(true);
      expect(existingData).toEqual(mockResearchData);
      expect(updateResult).not.toBeNull();
      expect(mockResearchDataRepo.findByUrlAndOrganizationId).toHaveBeenCalledWith(url, 'org-123');
    });

    it('should handle user-fallback workflow', async () => {
      // Arrange
      const url = 'https://user-example.com';
      mockResearchDataRepo.findByUrlAndUserId.mockResolvedValue(null);

      // Act
      const scope = getResearchDataScope(mockResearchTaskWithoutOrganization, mockUser);
      const hasOrgContext = hasOrganizationContext(mockResearchTaskWithoutOrganization);
      const existingData = await findExistingResearchData(
        url,
        mockResearchTaskWithoutOrganization,
        mockUser,
        mockResearchDataRepo
      );
      const updateResult = await findOrUpdateExistingResearchData(
        url,
        'content',
        'text/markdown',
        mockResearchTaskWithoutOrganization,
        mockUser,
        adapters,
        mockLogger
      );

      // Assert
      expect(scope.scope).toBe('user');
      expect(hasOrgContext).toBe(false);
      expect(existingData).toBeNull();
      expect(updateResult).toBeNull();
      expect(mockResearchDataRepo.findByUrlAndUserId).toHaveBeenCalledWith(url, 'test-user-123');
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in URL', async () => {
      // Arrange
      const specialUrl = 'https://example.com/path?query=value&special=characters%20encoded';
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(null);

      // Act
      const result = await findExistingResearchData(
        specialUrl,
        mockResearchTaskWithOrganization,
        mockUser,
        mockResearchDataRepo
      );

      // Assert
      expect(mockResearchDataRepo.findByUrlAndOrganizationId).toHaveBeenCalledWith(specialUrl, 'org-123');
      expect(result).toBeNull();
    });

    it('should handle very large content', async () => {
      // Arrange
      const largeContent = 'x'.repeat(10000); // 10KB content
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
      mockFabFilesRepo.findById.mockResolvedValue(mockFabFile);

      // Act
      const result = await findOrUpdateExistingResearchData(
        'https://example.com',
        largeContent,
        'text/plain',
        mockResearchTaskWithOrganization,
        mockUser,
        adapters,
        mockLogger
      );

      // Assert
      expect(result).not.toBeNull();
      expect(mockStorage.upload).toHaveBeenCalledWith('test/path/file.md', largeContent, {
        ContentType: 'text/plain',
        ContentLength: 10000,
      });
    });

    it('should handle storage upload failure', async () => {
      // Arrange
      mockResearchDataRepo.findByUrlAndOrganizationId.mockResolvedValue(mockResearchData);
      mockFabFilesRepo.findById.mockResolvedValue(mockFabFile);
      mockStorage.upload.mockRejectedValue(new Error('Storage upload failed'));

      // Act & Assert
      await expect(
        findOrUpdateExistingResearchData(
          'https://example.com',
          'content',
          'text/markdown',
          mockResearchTaskWithOrganization,
          mockUser,
          adapters,
          mockLogger
        )
      ).rejects.toThrow('Storage upload failed');
    });
  });
});

describe('createSendStatusUpdate', () => {
  let mockResearchTask: any;
  let mockQueueRunner: any;
  let mockSendToClient: Mock;
  let mockLogger: { info: Mock; error: Mock };

  beforeEach(() => {
    mockResearchTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'processing',
    };

    mockQueueRunner = {
      add: vi.fn(),
    };

    mockSendToClient = vi.fn();

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    vi.clearAllMocks();
  });

  it('should create a function that sends status updates with default progress config', async () => {
    // Arrange
    const sendStatusUpdate = createSendStatusUpdate(mockResearchTask, mockQueueRunner, mockSendToClient, mockLogger);

    // Act
    await sendStatusUpdate('Test status message', 5);

    // Assert
    expect(mockQueueRunner.add).toHaveBeenCalledTimes(1);

    // Execute the queued function to test its behavior
    const queuedFunction = mockQueueRunner.add.mock.calls[0][0];
    await queuedFunction();

    expect(mockLogger.info).toHaveBeenCalledWith(`📡 [RESEARCH_TASK_task-123] Status: Test status message (5%)`);
    expect(mockSendToClient).toHaveBeenCalledWith(mockResearchTask, {
      status: 'processing',
      currentStep: 'Test status message',
      progress: 5,
    });
  });

  it('should respect custom progress configuration', async () => {
    // Arrange
    const currentProgressTracker = { value: 0 };
    const progressConfig = {
      baseProgress: 50,
      maxProgress: 80,
      currentProgress: currentProgressTracker,
    };

    const sendStatusUpdate = createSendStatusUpdate(
      mockResearchTask,
      mockQueueRunner,
      mockSendToClient,
      mockLogger,
      progressConfig
    );

    // Act
    await sendStatusUpdate('Test status', 20);

    // Assert
    expect(currentProgressTracker.value).toBe(20);
    expect(mockQueueRunner.add).toHaveBeenCalledTimes(1);

    // Execute the queued function
    const queuedFunction = mockQueueRunner.add.mock.calls[0][0];
    await queuedFunction();

    expect(mockLogger.info).toHaveBeenCalledWith(`📡 [RESEARCH_TASK_task-123] Status: Test status (70%)`);
    expect(mockSendToClient).toHaveBeenCalledWith(mockResearchTask, {
      status: 'processing',
      currentStep: 'Test status',
      progress: 70,
    });
  });

  it('should cap progress at maxProgress', async () => {
    // Arrange
    const currentProgressTracker = { value: 0 };
    const progressConfig = {
      baseProgress: 90,
      maxProgress: 100,
      currentProgress: currentProgressTracker,
    };

    const sendStatusUpdate = createSendStatusUpdate(
      mockResearchTask,
      mockQueueRunner,
      mockSendToClient,
      mockLogger,
      progressConfig
    );

    // Act - Large increment that would exceed maxProgress
    await sendStatusUpdate('Test status', 50);

    // Assert
    expect(currentProgressTracker.value).toBe(50);
    expect(mockQueueRunner.add).toHaveBeenCalledTimes(1);

    const queuedFunction = mockQueueRunner.add.mock.calls[0][0];
    await queuedFunction();

    expect(mockLogger.info).toHaveBeenCalledWith(`📡 [RESEARCH_TASK_task-123] Status: Test status (100%)`);
    expect(mockSendToClient).toHaveBeenCalledWith(mockResearchTask, {
      status: 'processing',
      currentStep: 'Test status',
      progress: 100,
    });
  });

  it('should handle undefined sendToClient gracefully', async () => {
    // Arrange
    const sendStatusUpdate = createSendStatusUpdate(
      mockResearchTask,
      mockQueueRunner,
      undefined, // No sendToClient function
      mockLogger
    );

    // Act
    await sendStatusUpdate('Test without client');

    // Assert
    const queuedFunction = mockQueueRunner.add.mock.calls[0][0];
    await queuedFunction();

    expect(mockLogger.info).toHaveBeenCalledWith(
      `⚠️ [NO_STATUS_SENDER] StatusSender adapter not available for task task-123`
    );
    expect(mockSendToClient).not.toHaveBeenCalled();
  });

  it('should work without logger', async () => {
    // Arrange
    const sendStatusUpdate = createSendStatusUpdate(
      mockResearchTask,
      mockQueueRunner,
      mockSendToClient
      // No logger provided
    );

    // Act & Assert - Should not throw
    await sendStatusUpdate('Test without logger');

    const queuedFunction = mockQueueRunner.add.mock.calls[0][0];
    await queuedFunction();

    expect(mockSendToClient).toHaveBeenCalledWith(mockResearchTask, {
      status: 'processing',
      currentStep: 'Test without logger',
      progress: 10,
    });
  });

  it('should handle sendToClient errors gracefully', async () => {
    // Arrange
    const error = new Error('WebSocket connection failed');
    mockSendToClient.mockRejectedValue(error);

    const sendStatusUpdate = createSendStatusUpdate(mockResearchTask, mockQueueRunner, mockSendToClient, mockLogger);

    // Act
    await sendStatusUpdate('Test error handling');

    // Assert
    const queuedFunction = mockQueueRunner.add.mock.calls[0][0];
    await queuedFunction();

    expect(mockLogger.error).toHaveBeenCalledWith(
      `❌ [WEBSOCKET_ERROR] Failed to send status update for task task-123: WebSocket connection failed`
    );
  });

  it('should accumulate progress over multiple calls', async () => {
    // Arrange
    const currentProgressTracker = { value: 0 };
    const progressConfig = {
      baseProgress: 0,
      maxProgress: 100,
      currentProgress: currentProgressTracker,
    };

    const sendStatusUpdate = createSendStatusUpdate(
      mockResearchTask,
      mockQueueRunner,
      mockSendToClient,
      mockLogger,
      progressConfig
    );

    // Act - Multiple calls
    await sendStatusUpdate('First update', 10);
    await sendStatusUpdate('Second update', 15);
    await sendStatusUpdate('Third update', 20);

    // Assert
    expect(currentProgressTracker.value).toBe(45); // 10 + 15 + 20
    expect(mockQueueRunner.add).toHaveBeenCalledTimes(3);

    // Check the last call
    const lastQueuedFunction = mockQueueRunner.add.mock.calls[2][0];
    await lastQueuedFunction();

    // Verify that the status message includes the accumulated progress
    expect(mockLogger.info).toHaveBeenCalledWith(`📡 [RESEARCH_TASK_task-123] Status: Third update (45%)`);
  });

  it('should use default progress increment when none provided', async () => {
    // Arrange
    const sendStatusUpdate = createSendStatusUpdate(mockResearchTask, mockQueueRunner, mockSendToClient, mockLogger);

    // Act - No progress increment provided
    await sendStatusUpdate('Default increment test');

    // Assert
    const queuedFunction = mockQueueRunner.add.mock.calls[0][0];
    await queuedFunction();

    expect(mockLogger.info).toHaveBeenCalledWith(`📡 [RESEARCH_TASK_task-123] Status: Default increment test (10%)`);
  });

  it('should handle zero progress increment', async () => {
    // Arrange
    const currentProgressTracker = { value: 5 };
    const progressConfig = {
      baseProgress: 20,
      maxProgress: 100,
      currentProgress: currentProgressTracker,
    };

    const sendStatusUpdate = createSendStatusUpdate(
      mockResearchTask,
      mockQueueRunner,
      mockSendToClient,
      mockLogger,
      progressConfig
    );

    // Act
    await sendStatusUpdate('Zero increment', 0);

    // Assert
    expect(currentProgressTracker.value).toBe(5); // No change

    const queuedFunction = mockQueueRunner.add.mock.calls[0][0];
    await queuedFunction();

    expect(mockLogger.info).toHaveBeenCalledWith(`📡 [RESEARCH_TASK_task-123] Status: Zero increment (25%)`);
  });

  it('should handle negative progress increment', async () => {
    // Arrange
    const currentProgressTracker = { value: 20 };
    const progressConfig = {
      baseProgress: 10,
      maxProgress: 100,
      currentProgress: currentProgressTracker,
    };

    const sendStatusUpdate = createSendStatusUpdate(
      mockResearchTask,
      mockQueueRunner,
      mockSendToClient,
      mockLogger,
      progressConfig
    );

    // Act
    await sendStatusUpdate('Negative increment', -5);

    // Assert
    expect(currentProgressTracker.value).toBe(15); // 20 - 5

    const queuedFunction = mockQueueRunner.add.mock.calls[0][0];
    await queuedFunction();

    expect(mockLogger.info).toHaveBeenCalledWith(`📡 [RESEARCH_TASK_task-123] Status: Negative increment (25%)`);
  });

  it('should log websocket attempts and successes', async () => {
    // Arrange
    const sendStatusUpdate = createSendStatusUpdate(mockResearchTask, mockQueueRunner, mockSendToClient, mockLogger);

    // Act
    await sendStatusUpdate('Websocket logging test');

    // Assert
    const queuedFunction = mockQueueRunner.add.mock.calls[0][0];
    await queuedFunction();

    expect(mockLogger.info).toHaveBeenNthCalledWith(
      1,
      `📡 [RESEARCH_TASK_task-123] Status: Websocket logging test (10%)`
    );
    expect(mockLogger.info).toHaveBeenNthCalledWith(
      2,
      `📤 [WEBSOCKET_ATTEMPT] Sending status update: Websocket logging test`
    );
    expect(mockLogger.info).toHaveBeenNthCalledWith(
      3,
      `📡 [WEBSOCKET_SENT] TaskId: task-123, Status: Websocket logging test, Progress: 10%`
    );
  });

  it('should handle different research task structures', async () => {
    // Arrange
    const differentTask = {
      id: 'different-task-456',
      title: 'Different Task',
      userId: 'user-123',
    } as any; // Type assertion for test purposes

    const sendStatusUpdate = createSendStatusUpdate(differentTask, mockQueueRunner, mockSendToClient, mockLogger);

    // Act
    await sendStatusUpdate('Different task test');

    // Assert
    const queuedFunction = mockQueueRunner.add.mock.calls[0][0];
    await queuedFunction();

    expect(mockLogger.info).toHaveBeenCalledWith(
      `📡 [RESEARCH_TASK_different-task-456] Status: Different task test (10%)`
    );
    expect(mockSendToClient).toHaveBeenCalledWith(differentTask, {
      status: 'processing',
      currentStep: 'Different task test',
      progress: 10,
    });
  });
});
