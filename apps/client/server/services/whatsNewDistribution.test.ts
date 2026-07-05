import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WhatsNewDistributionService, WhatsNewModalPayloadSchema } from './whatsNewDistribution';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand as _PutObjectCommand } from '@aws-sdk/client-s3';

// Cast to any to resolve type mismatch with aws-sdk-client-mock
const PutObjectCommand = _PutObjectCommand as any;

// Mock SST Resource
vi.mock('sst', () => ({
  Resource: {
    whatsNewDistributionBucket: { name: 'test-bucket' },
  },
}));

// Mock CloudWatch metrics
vi.mock('@server/utils/cloudwatch', () => ({
  emitModalGenerationMetrics: vi.fn().mockResolvedValue(undefined),
}));

// Mock Logger
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }),
}));

describe('WhatsNewDistributionService', () => {
  const s3Mock = mockClient(S3Client as any);
  const originalEnv = process.env;

  const createMockPayload = (overrides = {}) => ({
    modalId: 'test-modal-123',
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
    s3Mock.reset();
    // Enable distribution for most tests (simulates main production)
    process.env = { ...originalEnv, ENABLE_WHATS_NEW_DISTRIBUTION: 'true' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('uploadModal', () => {
    it('should upload modal to S3 in production environment', async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      const payload = createMockPayload({ environment: 'production' });
      await WhatsNewDistributionService.uploadModal(payload);

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls.length).toBe(2);

      // First call: production/{date}.json (archive first to prevent inconsistent state)
      expect(calls[0].args[0].input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'production/2024-01-15.json',
        ContentType: 'application/json',
        CacheControl: 'max-age=300, must-revalidate',
      });

      // Second call: latest.json
      expect(calls[1].args[0].input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'latest.json',
        ContentType: 'application/json',
        CacheControl: 'max-age=300, must-revalidate',
      });
    });

    it('should skip upload in non-production environment', async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      const payload = createMockPayload({ environment: 'dev' });
      await WhatsNewDistributionService.uploadModal(payload);

      // No S3 calls should be made
      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls.length).toBe(0);
    });

    it('should use releaseTag as filename when generatedDate is not available', async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      const payload = createMockPayload({
        environment: 'production',
        generatedDate: undefined,
        releaseTag: 'v2.0.0',
      });
      await WhatsNewDistributionService.uploadModal(payload);

      const calls = s3Mock.commandCalls(PutObjectCommand);
      // Archive is uploaded first (index 0)
      expect(calls[0].args[0].input.Key).toBe('production/v2.0.0.json');
    });

    it('should retry on transient S3 failures', async () => {
      let callCount = 0;
      s3Mock.on(PutObjectCommand).callsFake(() => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('ServiceUnavailable');
        }
        return {};
      });

      const payload = createMockPayload({ environment: 'production' });
      await WhatsNewDistributionService.uploadModal(payload);

      // Should have retried - each file uploaded successfully after retries
      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls.length).toBeGreaterThan(2);
    });

    it('should throw after max retries exceeded', async () => {
      s3Mock.on(PutObjectCommand).rejects(new Error('PermanentFailure'));

      const payload = createMockPayload({ environment: 'production' });

      await expect(WhatsNewDistributionService.uploadModal(payload)).rejects.toThrow('PermanentFailure');
    });

    it('should include version 1.0 in uploaded content', async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      const payload = createMockPayload({ environment: 'production' });
      await WhatsNewDistributionService.uploadModal(payload);

      const calls = s3Mock.commandCalls(PutObjectCommand);
      const uploadedContent = JSON.parse(calls[0].args[0].input.Body as string);
      expect(uploadedContent.version).toBe('1.0');
    });

    it('should skip upload when ENABLE_WHATS_NEW_DISTRIBUTION is not set (fork mode)', async () => {
      // Simulate fork environment - distribution not enabled
      delete process.env.ENABLE_WHATS_NEW_DISTRIBUTION;

      s3Mock.on(PutObjectCommand).resolves({});

      const payload = createMockPayload({ environment: 'production' });
      await WhatsNewDistributionService.uploadModal(payload);

      // No S3 calls should be made
      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls.length).toBe(0);
    });

    it('should skip upload when ENABLE_WHATS_NEW_DISTRIBUTION is false', async () => {
      process.env.ENABLE_WHATS_NEW_DISTRIBUTION = 'false';

      s3Mock.on(PutObjectCommand).resolves({});

      const payload = createMockPayload({ environment: 'production' });
      await WhatsNewDistributionService.uploadModal(payload);

      // No S3 calls should be made
      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls.length).toBe(0);
    });
  });

  describe('WhatsNewModalPayloadSchema', () => {
    it('should validate valid payload', () => {
      const payload = createMockPayload();
      const result = WhatsNewModalPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('should reject payload with invalid generatedDate format', () => {
      const payload = createMockPayload({ generatedDate: '2024/01/15' });
      const result = WhatsNewModalPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('should reject payload with title exceeding max length', () => {
      const payload = createMockPayload({ title: 'A'.repeat(201) });
      const result = WhatsNewModalPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('should reject payload with subtitle exceeding max length', () => {
      const payload = createMockPayload({ subtitle: 'A'.repeat(501) });
      const result = WhatsNewModalPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('should reject payload with description exceeding max length', () => {
      const payload = createMockPayload({ description: 'A'.repeat(15001) });
      const result = WhatsNewModalPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('should reject payload with invalid environment', () => {
      const payload = createMockPayload({ environment: 'staging' });
      const result = WhatsNewModalPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('should default version to 1.0 when not provided', () => {
      const payload = createMockPayload();
      delete (payload as any).version;
      const result = WhatsNewModalPayloadSchema.parse(payload);
      expect(result.version).toBe('1.0');
    });

    it('should accept payload without optional fields', () => {
      const payload = {
        modalId: 'test-modal',
        title: 'Test',
        subtitle: 'Subtitle',
        description: 'Description',
        environment: 'production',
        createdAt: '2024-01-15T10:00:00.000Z',
        metadata: {
          modelUsed: 'gpt-4',
          correlationId: 'test-id',
          repositoryUrl: 'https://github.com/test/repo',
        },
      };
      const result = WhatsNewModalPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });
});
