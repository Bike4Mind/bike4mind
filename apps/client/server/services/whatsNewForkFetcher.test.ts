import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { ModalModel } from '@bike4mind/database';

// Use vi.hoisted to ensure mock function is available during module initialization
const { mockAxiosGet, mockIsAxiosError, mockResource } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
  mockIsAxiosError: vi.fn((error: any) => error?.isAxiosError === true),
  mockResource: {
    App: { stage: 'dev' },
    WHATS_NEW_DISTRIBUTION_URL: { value: 'https://test123.cloudfront.net/whats-new' },
  },
}));

// Mock SST Resource module
vi.mock('sst', () => ({
  Resource: mockResource,
}));

// Mock all external dependencies before importing the module under test
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: mockAxiosGet,
    })),
    isAxiosError: mockIsAxiosError,
  },
}));

vi.mock('axios-retry', () => ({
  default: vi.fn(),
  isNetworkOrIdempotentRequestError: vi.fn(() => false),
}));

vi.mock('@bike4mind/database', () => ({
  ModalModel: {
    findOne: vi.fn(),
    find: vi.fn(),
    create: vi.fn(),
    findByIdAndDelete: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
  AdminSettings: {
    findOne: vi.fn().mockResolvedValue(null), // Default: no admin override
  },
}));

vi.mock('@server/utils/cloudwatch', () => ({
  emitModalGenerationMetrics: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }),
}));

// Import module under test after mocks are set up
import { WhatsNewForkFetcher, clearDistributionUrlCache, validateDistributionUrl } from './whatsNewForkFetcher';
import { AdminSettings } from '@bike4mind/database';

describe('WhatsNewForkFetcher', () => {
  const createMockModalPayload = (overrides = {}) => ({
    version: '1.0',
    modalId: 'production-modal-123',
    title: 'Test Modal Title',
    subtitle: 'Test subtitle for the modal',
    description: 'Test description content',
    generatedDate: '2024-01-15',
    releaseTag: 'v1.0.0',
    releases: ['v1.0.0'],
    environment: 'production' as const,
    createdAt: '2024-01-15T10:00:00.000Z',
    metadata: {
      modelUsed: 'gpt-4o-mini',
      correlationId: 'test-correlation-id',
      repositoryUrl: 'https://github.com/test/repo',
    },
    ...overrides,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    // Reset mock Resource to default dev values
    mockResource.App.stage = 'dev';
    mockResource.WHATS_NEW_DISTRIBUTION_URL = { value: 'https://test123.cloudfront.net/whats-new' };
    // Clear URL cache to ensure fresh lookup each test
    clearDistributionUrlCache();
    // Default: no admin override (uses SST secret)
    vi.mocked(AdminSettings.findOne).mockResolvedValue(null);
  });

  afterEach(() => {
    // Reset to defaults
    mockResource.App.stage = 'dev';
    mockResource.WHATS_NEW_DISTRIBUTION_URL = { value: 'https://test123.cloudfront.net/whats-new' };
  });

  describe('fetchAndImportLatest', () => {
    it('should skip in production environment', async () => {
      mockResource.App.stage = 'production';

      const result = await WhatsNewForkFetcher.fetchAndImportLatest();

      expect(result.imported).toBe(false);
      expect(result.reason).toContain('Production environment');
    });

    it('should fetch and import modal in non-production environment', async () => {
      mockResource.App.stage = 'dev';
      const mockPayload = createMockModalPayload();

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: mockPayload,
      });

      // No existing modal
      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      const result = await WhatsNewForkFetcher.fetchAndImportLatest();

      expect(result.imported).toBe(true);
      expect(result.reason).toContain('Imported modal');
    });

    it('should skip if modal already exists by sourceModalId', async () => {
      mockResource.App.stage = 'dev';
      const mockPayload = createMockModalPayload();

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: mockPayload,
      });

      // Existing modal found
      (ModalModel.findOne as any).mockResolvedValue({
        _id: 'existing-modal-id',
        generationMetadata: { sourceModalId: 'production-modal-123' },
      });

      const result = await WhatsNewForkFetcher.fetchAndImportLatest();

      expect(result.imported).toBe(false);
      expect(result.reason).toContain('already exists');
    });

    it('should skip if modal already exists by generatedDate', async () => {
      mockResource.App.stage = 'dev';
      const mockPayload = createMockModalPayload();

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: mockPayload,
      });

      // First findOne (by sourceModalId) returns null, second (by date) returns existing
      (ModalModel.findOne as any).mockResolvedValueOnce(null).mockResolvedValueOnce({
        _id: 'existing-modal-id',
        generationMetadata: { generatedDate: '2024-01-15' },
      });

      const result = await WhatsNewForkFetcher.fetchAndImportLatest();

      expect(result.imported).toBe(false);
      expect(result.reason).toContain('already exists');
    });

    it('should return no modal available when 404 is returned', async () => {
      mockResource.App.stage = 'dev';

      const axiosError = {
        isAxiosError: true,
        response: { status: 404 },
      };
      mockAxiosGet.mockRejectedValue(axiosError);
      mockIsAxiosError.mockReturnValue(true);

      const result = await WhatsNewForkFetcher.fetchAndImportLatest();

      expect(result.imported).toBe(false);
      expect(result.reason).toContain('No modal available');
    });

    it('should throw on non-404 HTTP errors', async () => {
      mockResource.App.stage = 'dev';

      const axiosError = {
        isAxiosError: true,
        response: { status: 500 },
        message: 'Internal Server Error',
      };
      mockAxiosGet.mockRejectedValue(axiosError);
      mockIsAxiosError.mockReturnValue(true);

      await expect(WhatsNewForkFetcher.fetchAndImportLatest()).rejects.toMatchObject({
        isAxiosError: true,
        response: { status: 500 },
      });
    });

    it('should validate schema before import', async () => {
      mockResource.App.stage = 'dev';
      const invalidPayload = {
        // Missing required fields
        modalId: 'test',
        title: 'Test',
      };

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: invalidPayload,
      });

      // Schema validation should throw
      await expect(WhatsNewForkFetcher.fetchAndImportLatest()).rejects.toThrow();
    });

    it('should create modal with correct fields', async () => {
      mockResource.App.stage = 'dev';
      const mockPayload = createMockModalPayload();

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: mockPayload,
      });

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      await WhatsNewForkFetcher.fetchAndImportLatest();

      expect(ModalModel.create).toHaveBeenCalledWith([
        expect.objectContaining({
          title: mockPayload.title,
          subtitle: mockPayload.subtitle,
          description: mockPayload.description,
          tags: expect.arrayContaining(['whats-new', 'imported-from-production']),
          priority: 10,
          closeButton: true,
          agreeButton: true,
          enabled: true,
          isBanner: false,
          generationMetadata: expect.objectContaining({
            sourceModalId: mockPayload.modalId,
            generatedDate: mockPayload.generatedDate,
            releaseTag: mockPayload.releaseTag,
            releases: mockPayload.releases,
            correlationId: mockPayload.metadata.correlationId,
            modelUsed: mockPayload.metadata.modelUsed,
            importedFrom: 'production',
          }),
        }),
      ]);
    });

    it('should set modal dates correctly', async () => {
      mockResource.App.stage = 'dev';
      const mockPayload = createMockModalPayload();

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: mockPayload,
      });

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      const beforeCall = new Date();
      await WhatsNewForkFetcher.fetchAndImportLatest();
      const afterCall = new Date();

      const createCall = (ModalModel.create as any).mock.calls[0][0][0];

      // startDate should be approximately now
      expect(createCall.startDate.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(createCall.startDate.getTime()).toBeLessThanOrEqual(afterCall.getTime());

      // endDate should be ~30 days from now
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(createCall.endDate.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime() + thirtyDaysMs - 1000);
      expect(createCall.endDate.getTime()).toBeLessThanOrEqual(afterCall.getTime() + thirtyDaysMs + 1000);
    });

    it('should handle network errors gracefully', async () => {
      mockResource.App.stage = 'dev';

      const networkError = new Error('Network Error');
      mockAxiosGet.mockRejectedValue(networkError);
      mockIsAxiosError.mockReturnValue(false);

      await expect(WhatsNewForkFetcher.fetchAndImportLatest()).rejects.toThrow('Network Error');
    });
  });

  describe('environment handling', () => {
    it('should work with different non-production stages', async () => {
      const stages = ['dev', 'staging', 'test', 'fork-123'];

      for (const stage of stages) {
        mockResource.App.stage = stage;
        vi.resetAllMocks();
        clearDistributionUrlCache();
        vi.mocked(AdminSettings.findOne).mockResolvedValue(null);

        mockAxiosGet.mockResolvedValue({
          status: 200,
          data: createMockModalPayload(),
        });

        (ModalModel.findOne as any).mockResolvedValue(null);
        (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

        const result = await WhatsNewForkFetcher.fetchAndImportLatest();
        expect(result.imported).toBe(true);
      }
    });
  });

  describe('distribution URL selection', () => {
    it('should use admin override URL when configured', async () => {
      mockResource.App.stage = 'dev';
      const adminUrl = 'https://admin-override.cloudfront.net/whats-new';

      // Configure admin override
      vi.mocked(AdminSettings.findOne).mockResolvedValue({
        settingName: 'whatsNewSyncConfig',
        settingValue: {
          autoSyncEnabled: true,
          distributionUrlOverride: adminUrl,
        },
      } as any);

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: createMockModalPayload(),
      });

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      await WhatsNewForkFetcher.fetchAndImportLatest();

      // Verify the admin URL was used (should be in the axios call URL)
      expect(mockAxiosGet).toHaveBeenCalledWith(expect.stringContaining('admin-override.cloudfront.net'));
    });

    it('should fall back to SST secret when no admin override', async () => {
      mockResource.App.stage = 'dev';
      mockResource.WHATS_NEW_DISTRIBUTION_URL = { value: 'https://sst-secret.cloudfront.net/whats-new' };

      // No admin override
      vi.mocked(AdminSettings.findOne).mockResolvedValue(null);

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: createMockModalPayload(),
      });

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      await WhatsNewForkFetcher.fetchAndImportLatest();

      // Verify the SST URL was used
      expect(mockAxiosGet).toHaveBeenCalledWith(expect.stringContaining('sst-secret.cloudfront.net'));
    });

    it('should fall back to SST secret when admin override is invalid', async () => {
      mockResource.App.stage = 'dev';
      mockResource.WHATS_NEW_DISTRIBUTION_URL = { value: 'https://fallback.cloudfront.net/whats-new' };

      // Configure invalid admin override (non-allowed domain)
      vi.mocked(AdminSettings.findOne).mockResolvedValue({
        settingName: 'whatsNewSyncConfig',
        settingValue: {
          autoSyncEnabled: true,
          distributionUrlOverride: 'https://evil.com/malicious', // Not allowed
        },
      } as any);

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: createMockModalPayload(),
      });

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      await WhatsNewForkFetcher.fetchAndImportLatest();

      // Verify it fell back to SST URL, not the invalid admin URL
      expect(mockAxiosGet).toHaveBeenCalledWith(expect.stringContaining('fallback.cloudfront.net'));
      expect(mockAxiosGet).not.toHaveBeenCalledWith(expect.stringContaining('evil.com'));
    });

    it('should throw when neither admin override nor SST secret is configured', async () => {
      mockResource.App.stage = 'dev';
      mockResource.WHATS_NEW_DISTRIBUTION_URL = { value: 'not-configured' };

      // No admin override
      vi.mocked(AdminSettings.findOne).mockResolvedValue(null);

      await expect(WhatsNewForkFetcher.fetchAndImportLatest()).rejects.toThrow('Distribution URL is not configured');
    });

    it('should cache URL within single sync operation', async () => {
      mockResource.App.stage = 'dev';
      const adminUrl = 'https://cached.cloudfront.net/whats-new';

      vi.mocked(AdminSettings.findOne).mockResolvedValue({
        settingName: 'whatsNewSyncConfig',
        settingValue: {
          autoSyncEnabled: true,
          distributionUrlOverride: adminUrl,
        },
      } as any);

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: createMockModalPayload(),
      });

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      await WhatsNewForkFetcher.fetchAndImportLatest();

      // AdminSettings.findOne should only be called once per sync due to caching
      expect(AdminSettings.findOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('syncExistingModals', () => {
    const createMockManifest = (modals: any[] = []) => ({
      schemaVersion: 1,
      version: '1.0.0',
      lastUpdated: '2024-01-15T10:00:00.000Z',
      modals,
    });

    const createMockManifestEntry = (overrides = {}) => ({
      id: 'production-modal-123',
      key: 'production/2024-01-15.json',
      generatedDate: '2024-01-15',
      title: 'Test Modal',
      contentHash: 'sha256:abc123',
      uploadedAt: '2024-01-15T10:00:00.000Z',
      ...overrides,
    });

    const createMockLocalModal = (overrides = {}) => ({
      _id: 'local-modal-id',
      title: 'Test Modal',
      generationMetadata: {
        sourceModalId: 'production-modal-123',
        sourceContentHash: 'sha256:abc123',
        importedFrom: 'production',
      },
      ...overrides,
    });

    it('should skip in production environment', async () => {
      mockResource.App.stage = 'production';

      const result = await WhatsNewForkFetcher.syncExistingModals();

      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.upToDate).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle missing manifest gracefully', async () => {
      mockResource.App.stage = 'dev';

      const axiosError = {
        isAxiosError: true,
        response: { status: 404 },
      };
      mockAxiosGet.mockRejectedValue(axiosError);
      mockIsAxiosError.mockReturnValue(true);

      const result = await WhatsNewForkFetcher.syncExistingModals();

      expect(result.errors).toContain('Manifest not available');
    });

    it('should return early when no imported modals exist', async () => {
      mockResource.App.stage = 'dev';

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: createMockManifest([createMockManifestEntry()]),
      });
      (ModalModel.find as any).mockResolvedValue([]);

      const result = await WhatsNewForkFetcher.syncExistingModals();

      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.upToDate).toBe(0);
    });

    it('should delete modal when marked deleted in manifest', async () => {
      mockResource.App.stage = 'dev';

      const deletedEntry = createMockManifestEntry({
        deleted: true,
        deletedAt: '2024-01-16T10:00:00.000Z',
      });

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: createMockManifest([deletedEntry]),
      });
      (ModalModel.find as any).mockResolvedValue([createMockLocalModal()]);
      (ModalModel.findByIdAndDelete as any).mockResolvedValue({ _id: 'local-modal-id' });

      const result = await WhatsNewForkFetcher.syncExistingModals();

      expect(result.deleted).toBe(1);
      expect(ModalModel.findByIdAndDelete).toHaveBeenCalledWith('local-modal-id');
    });

    it('should update modal when hash mismatch detected', async () => {
      mockResource.App.stage = 'dev';

      const updatedPayload = createMockModalPayload({
        title: 'Updated Title',
      });
      // Calculate the actual hash of the payload (matching what updateLocalModal does)
      const payloadContent = JSON.stringify(updatedPayload, null, 2);
      const actualHash = `sha256:${createHash('sha256').update(payloadContent).digest('hex')}`;

      const updatedEntry = createMockManifestEntry({
        contentHash: actualHash, // Use actual hash so verification passes
      });

      // First call for manifest, second call for modal content
      mockAxiosGet
        .mockResolvedValueOnce({
          status: 200,
          data: createMockManifest([updatedEntry]),
        })
        .mockResolvedValueOnce({
          status: 200,
          data: updatedPayload,
        });

      const localModal = createMockLocalModal({
        generationMetadata: {
          sourceModalId: 'production-modal-123',
          sourceContentHash: 'sha256:oldhash123', // Old hash - different from manifest
          importedFrom: 'production',
        },
      });
      (ModalModel.find as any).mockResolvedValue([localModal]);
      (ModalModel.findByIdAndUpdate as any).mockResolvedValue({});

      const result = await WhatsNewForkFetcher.syncExistingModals();

      expect(result.updated).toBe(1);
      expect(ModalModel.findByIdAndUpdate).toHaveBeenCalled();
    });

    it('should skip update when hash matches (up-to-date)', async () => {
      mockResource.App.stage = 'dev';

      const entry = createMockManifestEntry({
        contentHash: 'sha256:samehash',
      });

      mockAxiosGet.mockResolvedValue({
        status: 200,
        data: createMockManifest([entry]),
      });

      const localModal = createMockLocalModal({
        generationMetadata: {
          sourceModalId: 'production-modal-123',
          sourceContentHash: 'sha256:samehash', // Same hash
          importedFrom: 'production',
        },
      });
      (ModalModel.find as any).mockResolvedValue([localModal]);

      const result = await WhatsNewForkFetcher.syncExistingModals();

      expect(result.upToDate).toBe(1);
      expect(result.updated).toBe(0);
      expect(ModalModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('should handle per-modal errors without stopping entire sync', async () => {
      mockResource.App.stage = 'dev';

      const entry1 = createMockManifestEntry({
        id: 'modal-1',
        contentHash: 'sha256:newhash1',
      });
      const entry2 = createMockManifestEntry({
        id: 'modal-2',
        contentHash: 'sha256:hash2',
      });

      mockAxiosGet
        .mockResolvedValueOnce({
          status: 200,
          data: createMockManifest([entry1, entry2]),
        })
        .mockRejectedValueOnce(new Error('Network error')); // First modal fetch fails

      const localModals = [
        createMockLocalModal({
          _id: 'local-1',
          generationMetadata: {
            sourceModalId: 'modal-1',
            sourceContentHash: 'sha256:oldhash1',
            importedFrom: 'production',
          },
        }),
        createMockLocalModal({
          _id: 'local-2',
          generationMetadata: {
            sourceModalId: 'modal-2',
            sourceContentHash: 'sha256:hash2', // Same hash - up to date
            importedFrom: 'production',
          },
        }),
      ];
      (ModalModel.find as any).mockResolvedValue(localModals);

      const result = await WhatsNewForkFetcher.syncExistingModals();

      // First modal errored, second was up to date
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('modal-1');
      expect(result.upToDate).toBe(1);
    });

    it('should backfill when sourceContentHash is missing (pre-migration)', async () => {
      mockResource.App.stage = 'dev';

      const payload = createMockModalPayload();
      // Calculate the actual hash of the payload
      const payloadContent = JSON.stringify(payload, null, 2);
      const actualHash = `sha256:${createHash('sha256').update(payloadContent).digest('hex')}`;

      const entry = createMockManifestEntry({
        contentHash: actualHash, // Use actual hash so verification passes
      });

      mockAxiosGet
        .mockResolvedValueOnce({
          status: 200,
          data: createMockManifest([entry]),
        })
        .mockResolvedValueOnce({
          status: 200,
          data: payload,
        });

      // Local modal has no sourceContentHash (pre-migration)
      const localModal = createMockLocalModal({
        generationMetadata: {
          sourceModalId: 'production-modal-123',
          // No sourceContentHash - triggers backfill
          importedFrom: 'production',
        },
      });
      (ModalModel.find as any).mockResolvedValue([localModal]);
      (ModalModel.findByIdAndUpdate as any).mockResolvedValue({});

      const result = await WhatsNewForkFetcher.syncExistingModals();

      expect(result.updated).toBe(1);
      expect(ModalModel.findByIdAndUpdate).toHaveBeenCalledWith(
        'local-modal-id',
        expect.objectContaining({
          $set: expect.objectContaining({
            'generationMetadata.sourceContentHash': entry.contentHash,
          }),
        })
      );
    });
  });
});

describe('validateDistributionUrl (SSRF allowlist)', () => {
  const ORIGINAL_SERVER_DOMAIN = process.env.SERVER_DOMAIN;
  const ORIGINAL_ALLOWED_HOSTS = process.env.WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS;

  afterEach(() => {
    // Restore the ambient env so cross-test state doesn't leak (these read at call time).
    if (ORIGINAL_SERVER_DOMAIN === undefined) delete process.env.SERVER_DOMAIN;
    else process.env.SERVER_DOMAIN = ORIGINAL_SERVER_DOMAIN;
    if (ORIGINAL_ALLOWED_HOSTS === undefined) delete process.env.WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS;
    else process.env.WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS = ORIGINAL_ALLOWED_HOSTS;
  });

  it('rejects non-HTTPS URLs', () => {
    expect(validateDistributionUrl('http://test.cloudfront.net/x')).toEqual({
      valid: false,
      error: 'URL must use HTTPS',
    });
  });

  it('allows CloudFront and S3 hosts without any operator config', () => {
    delete process.env.SERVER_DOMAIN;
    delete process.env.WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS;
    expect(validateDistributionUrl('https://abc.cloudfront.net/whats-new').valid).toBe(true);
    expect(validateDistributionUrl('https://bucket.s3.us-east-1.amazonaws.com/whats-new').valid).toBe(true);
  });

  it("allows the deployment's own SERVER_DOMAIN", () => {
    process.env.SERVER_DOMAIN = 'myfork.example';
    expect(validateDistributionUrl('https://files.myfork.example/whats-new').valid).toBe(true);
  });

  it('rejects a custom upstream host when no override is configured', () => {
    delete process.env.SERVER_DOMAIN;
    delete process.env.WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS;
    expect(validateDistributionUrl('https://feed.upstream.example/whats-new').valid).toBe(false);
  });

  it('allows a custom upstream host configured via WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS', () => {
    process.env.WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS = 'feed.upstream.example';
    expect(validateDistributionUrl('https://feed.upstream.example/whats-new').valid).toBe(true);
    // subdomains of the configured suffix are allowed too
    expect(validateDistributionUrl('https://cdn.feed.upstream.example/whats-new').valid).toBe(true);
  });

  it('normalizes the override list (leading dot, case, whitespace) and accepts multiple hosts', () => {
    process.env.WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS = '  .Feed.Upstream.Example , second.example ';
    expect(validateDistributionUrl('https://feed.upstream.example/x').valid).toBe(true);
    expect(validateDistributionUrl('https://second.example/x').valid).toBe(true);
  });

  it('still rejects look-alike hosts that only suffix-collide with the override', () => {
    process.env.WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS = 'feed.upstream.example';
    // not a subdomain of '.feed.upstream.example'
    expect(validateDistributionUrl('https://feed.upstream.example.attacker.com/x').valid).toBe(false);
  });
});
