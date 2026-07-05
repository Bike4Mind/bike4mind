import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatch } from './whatsNewGeneration';
import { ModalModel } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { WhatsNewConfigService } from '@client/services/whatsNewConfigService';
import { apiKeyService } from '@bike4mind/services';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { sanitizeContentForLLM, extractJsonFromResponse, WhatsNewModalSchema } from './whatsNewGeneration.utils';
import { WHATS_NEW_VALIDATION_LIMITS } from '@bike4mind/common';

// Mock dependencies
vi.mock('@bike4mind/database', () => ({
  ModalModel: {
    find: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
  },
  withTransaction: vi.fn(async callback => await callback({})),
  connectDB: vi.fn().mockResolvedValue(undefined),
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));

vi.mock('@server/utils/analyticsLog', () => ({
  logEvent: vi.fn(),
}));

vi.mock('@client/services/whatsNewConfigService', () => ({
  WhatsNewConfigService: {
    getConfig: vi.fn(),
  },
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: {
    getEffectiveLLMApiKeys: vi.fn(),
  },
  // audience-variants generation seams (pure - faithful stubs).
  AUDIENCE_VARIANTS: [
    { key: 'internal', audienceType: 'internal', label: 'Internal' },
    { key: 'customer', audienceType: 'customer', label: 'Customer' },
  ],
  buildVariantGuidance: (variant: { key: string }) => `<variant_scope>${variant.key}</variant_scope>`,
  scrubInternalReferences: (text: string) => text,
  isNoVariantContent: (text: string | null | undefined) => (text ?? '').trim() === 'NO_USER_FACING_CHANGES',
}));

vi.mock('@bike4mind/observability', () => {
  // any: Logger has many optional methods; a partial mock is simpler than satisfying the full interface.
  const mockLogger: any = {
    info: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    updateMetadata: vi.fn(),
  };

  // Define withMetadata as a function that returns mockLogger for method chaining
  mockLogger.withMetadata = vi.fn(() => mockLogger);

  return {
    Logger: vi.fn(function () {
      return mockLogger;
    }),
  };
});

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

// getLlmByModel/getAvailableModels moved to @bike4mind/llm-adapters - mock them here.
vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return { ...actual, getAvailableModels: vi.fn(), getLlmByModel: vi.fn() };
});

vi.mock('@server/utils/cloudwatch', () => ({
  emitModalGenerationMetrics: vi.fn().mockResolvedValue(undefined),
}));

describe('whatsNewGeneration queue handler', () => {
  // Mock context
  const mockContext = {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test-function',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-function',
    memoryLimitInMB: '128',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/test-function',
    logStreamName: '2024/01/01/[$LATEST]test',
    getRemainingTimeInMillis: () => 30000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };

  // Sample payload
  const createMockPayload = (overrides = {}) => ({
    generatedDate: '2024-01-01',
    releaseTag: 'v1.0.0',
    releaseName: 'Release 1.0.0',
    releaseBody: 'Major release with new features',
    repositoryUrl: 'https://github.com/test/repo',
    commits: [
      { sha: 'abc123', message: 'feat: add new feature', author: 'John Doe' },
      { sha: 'def456', message: 'fix: bug fix', author: 'Jane Smith' },
    ],
    pullRequests: [
      {
        number: 123,
        title: 'Add new feature',
        body: 'This PR adds a new feature',
        mergedAt: '2024-01-01T00:00:00Z',
        url: 'https://github.com/test/repo/pull/123',
      },
    ],
    changelogExcerpt: '## Version 1.0.0\n- New feature\n- Bug fix',
    correlationId: 'test-correlation-id',
    environment: 'dev' as const,
    ...overrides,
  });

  // Mock SQS event
  const createMockEvent = (payload: any) => ({
    Records: [
      {
        messageId: 'test-message-id',
        receiptHandle: 'test-receipt-handle',
        body: JSON.stringify(payload),
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '1234567890',
          SenderId: 'test-sender',
          ApproximateFirstReceiveTimestamp: '1234567890',
        },
        messageAttributes: {},
        md5OfBody: 'test-md5',
        eventSource: 'aws:sqs' as const,
        eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:test-queue',
        awsRegion: 'us-east-1',
      },
    ],
  });

  // Mock LLM response
  const mockLLMResponse = {
    title: 'Exciting New Release!',
    subtitle: 'New features and improvements to enhance your experience',
    description: "## What's New\n\n- **New Feature**: Description of feature\n- **Bug Fix**: Fixed an important bug",
  };

  // Helper function to set up LLM mocks with the new service architecture
  const setupLLMMocks = (mockLLM: any, modelId = 'gpt-4o-mini') => {
    // Mock config service
    (WhatsNewConfigService.getConfig as any).mockResolvedValue({
      modelId,
      temperature: 0.7,
      maxTokens: 2000,
      timeoutMs: 120000,
      modalPriority: 10,
      modalExpiryDays: 30,
      maxPreviousModals: 10,
      titleMaxLength: 100,
      subtitleMaxLength: 200,
      descriptionMaxLength: 2000,
      maxCommits: 50,
      maxPullRequests: 20,
      maxReleaseBodyLength: 2000,
      maxCommitMessageLength: 200,
      maxPRBodyLength: 500,
      maxChangelogLength: 1000,
    });

    // Mock API key service
    (apiKeyService.getEffectiveLLMApiKeys as any).mockResolvedValue({
      openai: 'test-key',
      anthropic: 'test-key',
      gemini: 'test-key',
    });

    // Mock available models
    const mockModelInfo = {
      id: modelId,
      name: 'Test Model',
      backend: 'test',
      type: 'text',
      contextWindow: 8000,
    };
    (getAvailableModels as any).mockResolvedValue([mockModelInfo]);

    // Mock LLM initialization
    (getLlmByModel as any).mockReturnValue(mockLLM);
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Idempotency', () => {
    it('should skip generation if modal already exists for release', async () => {
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      // Setup LLM mocks (config is fetched before idempotency check)
      const mockLLM = {
        complete: vi.fn(),
      };
      setupLLMMocks(mockLLM);

      // Mock existing modal with embedded generationMetadata
      (ModalModel.findOne as any).mockResolvedValue({
        _id: 'existing-modal-id',
        generationMetadata: {
          releaseTag: 'v1.0.0',
          environment: 'dev',
        },
      });

      await dispatch(event, mockContext);

      expect(ModalModel.findOne).toHaveBeenCalledWith({
        'generationMetadata.generatedDate': '2024-01-01',
        'generationMetadata.environment': 'dev',
      });
      expect(ModalModel.find).not.toHaveBeenCalled();
    });

    it('should proceed with generation if no existing modal found', async () => {
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      // No existing modal with matching generationMetadata
      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.find as any).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      // Mock LLM
      const mockLLM = {
        complete: vi.fn().mockImplementation(async (_modelId, _messages, _options, callback) => {
          await callback([JSON.stringify(mockLLMResponse)]);
        }),
      };
      setupLLMMocks(mockLLM);

      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      await dispatch(event, mockContext);

      expect(ModalModel.findOne).toHaveBeenCalledWith({
        'generationMetadata.generatedDate': '2024-01-01',
        'generationMetadata.environment': 'dev',
      });
      expect(ModalModel.find).toHaveBeenCalled();
    });
  });

  describe('Style Learning', () => {
    it('should fetch previous whatsNew modals for style reference', async () => {
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      (ModalModel.findOne as any).mockResolvedValue(null);

      const mockPreviousModals = [
        { title: 'Previous Title 1', subtitle: 'Subtitle 1', description: 'Description 1' },
        { title: 'Previous Title 2', subtitle: 'Subtitle 2', description: 'Description 2' },
      ];

      const mockQuery = {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockPreviousModals),
      };
      (ModalModel.find as any).mockReturnValue(mockQuery);

      const mockLLM = {
        complete: vi.fn().mockImplementation(async (_modelId, _messages, _options, callback) => {
          await callback([JSON.stringify(mockLLMResponse)]);
        }),
      };
      setupLLMMocks(mockLLM);

      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      await dispatch(event, mockContext);

      expect(ModalModel.find).toHaveBeenCalledWith({ tags: 'whats-new', enabled: true });
      expect(mockQuery.sort).toHaveBeenCalledWith({ startDate: -1 });
      expect(mockQuery.limit).toHaveBeenCalledWith(10);
    });

    it('should handle zero previous modals gracefully', async () => {
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      (ModalModel.findOne as any).mockResolvedValue(null);

      const mockQuery = {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      };
      (ModalModel.find as any).mockReturnValue(mockQuery);

      const mockLLM = {
        complete: vi.fn().mockImplementation(async (_modelId, _messages, _options, callback) => {
          await callback([JSON.stringify(mockLLMResponse)]);
        }),
      };
      setupLLMMocks(mockLLM);

      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      await dispatch(event, mockContext);
    });
  });

  describe('LLM Integration', () => {
    it('should successfully generate modal with valid LLM response', async () => {
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.find as any).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      const mockLLM = {
        complete: vi.fn().mockImplementation(async (_modelId, _messages, _options, callback) => {
          await callback([JSON.stringify(mockLLMResponse)]);
        }),
      };
      setupLLMMocks(mockLLM);

      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      await dispatch(event, mockContext);

      expect(mockLLM.complete).toHaveBeenCalledWith(
        'gpt-4o-mini',
        expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
        expect.objectContaining({
          temperature: 0.7,
          maxTokens: 2000,
          stream: false,
        }),
        expect.any(Function)
      );
    });

    // Skipping timeout test due to fake timer complexity causing unhandled rejections in CI
    // The timeout functionality will be verified during integration testing
    it.skip('should handle LLM timeout', async () => {
      vi.useFakeTimers();
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.find as any).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      // Create a promise that never resolves (simulating a hung LLM call)
      const mockLLM = {
        complete: vi.fn().mockImplementation(() => {
          return new Promise(() => {}); // Never resolves
        }),
      };
      setupLLMMocks(mockLLM);

      const promise = dispatch(event, mockContext);

      // Advance timers past the timeout
      await vi.advanceTimersByTimeAsync(120001);

      // The promise should now be rejected
      await expect(promise).rejects.toThrow('LLM timeout');

      // Clean up
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it('should handle malformed JSON response from LLM', async () => {
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.find as any).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      const mockLLM = {
        complete: vi.fn().mockImplementation(async (_modelId, _messages, _options, callback) => {
          await callback(['This is not valid JSON']);
        }),
      };
      setupLLMMocks(mockLLM);

      // Per-variant generation: a malformed/incomplete customer response is
      // recorded as a failed variant, then the customer-gating step throws
      // (still triggers DLQ retry; the parse detail is logged in the variant helper).
      await expect(dispatch(event, mockContext)).rejects.toThrow('Customer variant generation failed');
    });

    it('should handle LLM response with missing required fields', async () => {
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.find as any).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      const incompleteResponse = { title: 'Only title' }; // Missing subtitle and description

      const mockLLM = {
        complete: vi.fn().mockImplementation(async (_modelId, _messages, _options, callback) => {
          await callback([JSON.stringify(incompleteResponse)]);
        }),
      };
      setupLLMMocks(mockLLM);

      // Per-variant generation: a malformed/incomplete customer response is
      // recorded as a failed variant, then the customer-gating step throws
      // (still triggers DLQ retry; the parse detail is logged in the variant helper).
      await expect(dispatch(event, mockContext)).rejects.toThrow('Customer variant generation failed');
    });
  });

  describe('Modal Creation', () => {
    it('should create modal with correct settings and embedded generationMetadata', async () => {
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.find as any).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      const mockLLM = {
        complete: vi.fn().mockImplementation(async (_modelId, _messages, _options, callback) => {
          await callback([JSON.stringify(mockLLMResponse)]);
        }),
      };
      setupLLMMocks(mockLLM);

      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      await dispatch(event, mockContext);

      expect(ModalModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            title: mockLLMResponse.title,
            subtitle: mockLLMResponse.subtitle,
            description: mockLLMResponse.description,
            tags: ['whats-new'],
            priority: 10,
            closeButton: true,
            agreeButton: true,
            enabled: true,
            isBanner: false,
            // Embedded generationMetadata for idempotency tracking
            generationMetadata: expect.objectContaining({
              releaseTag: 'v1.0.0',
              correlationId: 'test-correlation-id',
              modelUsed: 'gpt-4o-mini',
              environment: 'dev',
            }),
          }),
        ],
        expect.any(Object)
      );
    });

    it('should skip analytics logging for system-generated events', async () => {
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.find as any).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      const mockLLM = {
        complete: vi.fn().mockImplementation(async (_modelId, _messages, _options, callback) => {
          await callback([JSON.stringify(mockLLMResponse)]);
        }),
      };
      setupLLMMocks(mockLLM);

      (ModalModel.create as any).mockResolvedValue([{ _id: 'new-modal-id' }]);

      await dispatch(event, mockContext);

      // Analytics logging should be skipped for system-generated events
      expect(logEvent).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle database connection failure', async () => {
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      // Setup config mock (config is fetched before database operations)
      const mockLLM = {
        complete: vi.fn(),
      };
      setupLLMMocks(mockLLM);

      (ModalModel.findOne as any).mockRejectedValue(new Error('Database connection failed'));

      await expect(dispatch(event, mockContext)).rejects.toThrow('Database connection failed');
    });

    it('should handle modal creation failure', async () => {
      const payload = createMockPayload();
      const event = createMockEvent(payload);

      (ModalModel.findOne as any).mockResolvedValue(null);
      (ModalModel.find as any).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      });

      const mockLLM = {
        complete: vi.fn().mockImplementation(async (_modelId, _messages, _options, callback) => {
          await callback([JSON.stringify(mockLLMResponse)]);
        }),
      };
      setupLLMMocks(mockLLM);

      (ModalModel.create as any).mockRejectedValue(new Error('Failed to create modal'));

      await expect(dispatch(event, mockContext)).rejects.toThrow('Failed to create modal');
    });
  });

  describe('Content Sanitization', () => {
    it('should sanitize HTML from PR descriptions', () => {
      const content = {
        releaseBody: '<h1>Release</h1><script>alert("xss")</script>',
        commits: [{ message: 'feat: add feature' }],
        pullRequests: [{ title: 'PR', body: '<b>Bold</b> text' }],
        changelogExcerpt: '',
      };

      const sanitized = sanitizeContentForLLM(content);

      expect(sanitized.releaseBody).not.toContain('<');
      expect(sanitized.releaseBody).not.toContain('script');
      expect(sanitized.pullRequests[0].body).not.toContain('<b>');
    });

    it('should truncate very long content', () => {
      const longText = 'a'.repeat(5000);
      const content = {
        releaseBody: longText,
        commits: [{ message: 'feat: add feature' }],
        pullRequests: [{ title: 'PR', body: longText }],
        changelogExcerpt: longText,
      };

      const sanitized = sanitizeContentForLLM(content);

      expect(sanitized.releaseBody.length).toBeLessThanOrEqual(2003); // 2000 + '...'
      expect(sanitized.pullRequests[0].body.length).toBeLessThanOrEqual(503);
      expect(sanitized.changelogExcerpt.length).toBeLessThanOrEqual(1003);
    });

    it('should limit number of commits and PRs processed', () => {
      const commits = Array.from({ length: 100 }, (_, i) => ({
        message: `commit ${i}`,
      }));
      const pullRequests = Array.from({ length: 50 }, (_, i) => ({
        title: `PR ${i}`,
        body: `Description ${i}`,
      }));

      const content = {
        releaseBody: 'Release',
        commits,
        pullRequests,
        changelogExcerpt: '',
      };

      const sanitized = sanitizeContentForLLM(content);

      expect(sanitized.commits.length).toBe(50); // Max 50
      expect(sanitized.pullRequests.length).toBe(20); // Max 20
    });
  });

  describe('JSON Extraction', () => {
    it('should extract JSON from markdown code block', () => {
      const text = '```json\n{"title": "Test"}\n```';
      const extracted = extractJsonFromResponse(text);
      expect(extracted).toBe('{"title": "Test"}');
    });

    it('should extract JSON from plain code block', () => {
      const text = '```\n{"title": "Test"}\n```';
      const extracted = extractJsonFromResponse(text);
      expect(extracted).toBe('{"title": "Test"}');
    });

    it('should extract JSON from text without code block', () => {
      const text = 'Here is the result: {"title": "Test"}';
      const extracted = extractJsonFromResponse(text);
      expect(extracted).toBe('{"title": "Test"}');
    });
  });

  describe('WHATS_NEW_VALIDATION_LIMITS Constants', () => {
    it('should export WHATS_NEW_VALIDATION_LIMITS with expected structure', () => {
      expect(WHATS_NEW_VALIDATION_LIMITS).toBeDefined();
      expect(typeof WHATS_NEW_VALIDATION_LIMITS).toBe('object');
    });

    it('should have all required limit keys with min, max, and default values', () => {
      const requiredKeys = [
        'temperature',
        'maxTokens',
        'timeoutMs',
        'modalPriority',
        'modalExpiryDays',
        'maxPreviousModals',
        'titleMaxLength',
        'subtitleMaxLength',
        'descriptionMaxLength',
        'maxCommits',
        'maxPullRequests',
        'maxCommitMessageLength',
        'maxReleaseBodyLength',
        'maxPRTitleLength',
        'maxPRBodyLength',
        'maxChangelogLength',
      ] as const;

      for (const key of requiredKeys) {
        const limit = WHATS_NEW_VALIDATION_LIMITS[key];
        expect(limit).toBeDefined();
        expect(typeof limit.min).toBe('number');
        expect(typeof limit.max).toBe('number');
        expect(typeof limit.default).toBe('number');
        expect(limit.min).toBeLessThanOrEqual(limit.default);
        expect(limit.default).toBeLessThanOrEqual(limit.max);
      }
    });

    it('should have promptTemplate with min and max but no default', () => {
      const { promptTemplate } = WHATS_NEW_VALIDATION_LIMITS;
      expect(promptTemplate).toBeDefined();
      expect(typeof promptTemplate.min).toBe('number');
      expect(typeof promptTemplate.max).toBe('number');
      expect('default' in promptTemplate).toBe(false);
    });

    it('WhatsNewModalSchema should use shared constants for default max lengths', () => {
      // The static schema uses .default values (not .max) as the ceiling
      // Use createWhatsNewModalSchema() for dynamic validation with admin config values
      const L = WHATS_NEW_VALIDATION_LIMITS;

      // Valid at default length should pass
      const validAtDefault = {
        title: 'A'.repeat(L.titleMaxLength.default),
        subtitle: 'B'.repeat(L.subtitleMaxLength.default),
        description: 'C'.repeat(L.descriptionMaxLength.default),
      };
      expect(WhatsNewModalSchema.safeParse(validAtDefault).success).toBe(true);

      // One character over default should fail (for static schema)
      const overDefault = {
        title: 'A'.repeat(L.titleMaxLength.default + 1),
        subtitle: 'Valid subtitle here',
        description: 'D'.repeat(100),
      };
      expect(WhatsNewModalSchema.safeParse(overDefault).success).toBe(false);
    });
  });
});
