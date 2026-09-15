import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock slackPackageInit to prevent transitive imports of @bike4mind/database and @server/*
vi.mock('@server/integrations/slack/slackPackageInit', () => ({
  initializeSlackPackage: vi.fn(),
}));

// Mock the dependencies using vi.hoisted
const {
  mockGitHubService,
  mockSlackClient,
  mockAdminSettings,
  mockAdminSettingsRepository,
  mockApiKeyRepository,
  mockApiKeyService,
  mockLogger,
} = vi.hoisted(() => ({
  mockGitHubService: {
    searchIssues: vi.fn(),
    createIssue: vi.fn(),
    ensureLabelExists: vi.fn(),
    testConnection: vi.fn(),
  },
  mockSlackClient: {
    fetchChannelHistory: vi.fn(),
    fetchChannelHistoryInTimeWindow: vi.fn(),
    sendMessage: vi.fn(),
  },
  mockAdminSettings: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    exists: vi.fn(),
  },
  mockAdminSettingsRepository: {
    getSettingsValue: vi.fn(),
  },
  mockApiKeyRepository: {},
  mockApiKeyService: {
    getEffectiveLLMApiKeys: vi.fn(),
  },
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock GitHubService - this is what we're testing the integration with
vi.mock('./githubService', () => ({
  GitHubService: {
    forSystem: vi.fn(),
    forOrganization: vi.fn(),
  },
}));

// Mock SlackClient
vi.mock('@bike4mind/slack', () => ({
  SlackClient: vi.fn(function () {
    return mockSlackClient;
  }),
}));

// Mock database
vi.mock('@bike4mind/database', () => ({
  AdminSettings: mockAdminSettings,
  adminSettingsRepository: mockAdminSettingsRepository,
  apiKeyRepository: mockApiKeyRepository,
}));

// Mock apiKeyService
vi.mock('@bike4mind/services', () => ({
  apiKeyService: mockApiKeyService,
}));

vi.mock('@bike4mind/utils', () => ({}));

// Logger moved to @bike4mind/observability - mock it here.
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return mockLogger;
  }),
}));

// getLlmByModel/getAvailableModels moved to @bike4mind/llm-adapters - mock them here.
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn(() => []),
  getLlmByModel: vi.fn(() => null),
  resolveDeprecatedModelId: vi.fn((id: string) => id),
}));

// Mock common
vi.mock('@bike4mind/common', () => ({
  LiveopsTriageConfigSchema: {
    parse: vi.fn(val => val),
  },
  ChatModels: {
    CLAUDE_4_6_SONNET_BEDROCK: 'claude-4-6-sonnet-bedrock',
    CLAUDE_4_5_HAIKU_BEDROCK: 'claude-4-5-haiku-bedrock',
    GPT4o: 'gpt-4o',
  },
  LIVEOPS_TRIAGE_VALIDATION_LIMITS: {
    temperature: { min: 0, max: 2, default: 0.3 },
    maxTokens: { min: 100, max: 10000, default: 1000 },
    timeoutMs: { min: 30000, max: 180000, default: 60000 },
    maxErrorsPerRun: { min: 1, max: 100, default: 50 },
    regressionLookbackDays: { min: 7, max: 180, default: 30 },
    regressionGracePeriodHours: { min: 1, max: 168, default: 48 },
    runIntervalHours: { options: [6, 12, 24], default: 12 },
    promptTemplate: { min: 50, max: 10000 },
  },
  LLMTriageResponseSchema: {
    safeParse: vi.fn(val => ({ success: true, data: val })),
  },
}));

import {
  createLiveopsTriageService,
  LiveopsTriageService,
  TriageResult,
  ExistingIssue,
  sanitizeErrorMessage,
  checkLLMMatchedClosedIssueRegression,
  REQUIRED_GITHUB_LABELS,
} from './liveopsTriageService';
import { GitHubService } from './githubService';
import { Logger } from '@bike4mind/observability';

describe('LiveopsTriageService', () => {
  let service: LiveopsTriageService;
  const logger = new Logger({ metadata: { component: 'test' } });

  const mockConfig = {
    enabled: true,
    slackChannelId: 'C123456',
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    modelId: 'claude-3-5-sonnet',
    temperature: 0.3,
    maxTokens: 1000,
    timeoutMs: 60000,
    maxErrorsPerRun: 50,
    autoCreateIssues: true,
  };

  const mockTriageResult: TriageResult = {
    alertId: 'alert-123',
    priority: 'P1',
    category: 'api',
    title: 'Test Error',
    body: 'Error details here',
    labels: ['bug', 'liveops'],
    matchesExisting: null,
    isRecurring: false,
    occurrenceCount: 1,
    isRegression: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = createLiveopsTriageService(logger);

    // Default mock responses
    mockAdminSettings.findOne.mockResolvedValue({
      settingName: 'liveopsTriageConfig',
      settingValue: mockConfig,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createLiveopsTriageService', () => {
    it('should create a service instance', () => {
      const service = createLiveopsTriageService();
      expect(service).toBeInstanceOf(LiveopsTriageService);
    });

    it('should accept a custom logger', () => {
      const customLogger = new Logger({ metadata: { custom: true } });
      const service = createLiveopsTriageService(customLogger);
      expect(service).toBeInstanceOf(LiveopsTriageService);
    });
  });

  describe('fetchExistingIssues', () => {
    it('should fetch issues using GitHubService.searchIssues', async () => {
      const mockIssues = [
        {
          number: 1,
          title: 'Existing Issue',
          state: 'open',
          labels: [{ name: 'liveops' }, { name: 'P1' }],
          created_at: '2024-01-01T00:00:00Z',
        },
        {
          number: 2,
          title: 'Another Issue',
          state: 'open',
          labels: [{ name: 'liveops' }, { name: 'P2' }],
          created_at: '2024-01-02T00:00:00Z',
        },
      ];

      mockGitHubService.searchIssues.mockResolvedValue(mockIssues);

      // Initialize the service with GitHubService
      service.initGitHubService(mockGitHubService as unknown as GitHubService);

      const result = await service.fetchExistingIssues('test-owner/test-repo');

      expect(mockGitHubService.searchIssues).toHaveBeenCalledWith(
        'test-owner/test-repo',
        'is:issue is:open label:liveops'
      );
      expect(result).toHaveLength(2);
      expect(result[0].number).toBe(1);
      expect(result[0].labels).toEqual(['liveops', 'P1']);
    });

    it('should return empty array when GitHubService returns empty', async () => {
      mockGitHubService.searchIssues.mockResolvedValue([]);

      service.initGitHubService(mockGitHubService as unknown as GitHubService);

      const result = await service.fetchExistingIssues('test-owner/test-repo');

      expect(result).toEqual([]);
    });

    it('should throw when GitHub service not initialized', async () => {
      await expect(service.fetchExistingIssues('test-owner/test-repo')).rejects.toThrow(
        'GitHub service not initialized'
      );
    });

    it('should return empty array on error and log the error', async () => {
      mockGitHubService.searchIssues.mockRejectedValue(new Error('API error'));

      service.initGitHubService(mockGitHubService as unknown as GitHubService);

      const result = await service.fetchExistingIssues('test-owner/test-repo');

      expect(result).toEqual([]);
      expect(mockLogger.error).toHaveBeenCalledWith('Error fetching existing issues:', expect.any(Error));
    });
  });

  describe('fetchRecentlyClosedIssues', () => {
    it('should fetch closed issues with correct date query', async () => {
      const mockClosedIssues = [
        {
          number: 10,
          title: 'Fixed Issue',
          state: 'closed',
          labels: [{ name: 'liveops' }, { name: 'P1' }],
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      mockGitHubService.searchIssues.mockResolvedValue(mockClosedIssues);
      service.initGitHubService(mockGitHubService as unknown as GitHubService);

      const result = await service.fetchRecentlyClosedIssues('test-owner/test-repo', 30);

      // Verify search query includes closed filter and date
      expect(mockGitHubService.searchIssues).toHaveBeenCalledWith(
        'test-owner/test-repo',
        expect.stringMatching(/is:issue is:closed label:liveops closed:>\d{4}-\d{2}-\d{2}/)
      );
      expect(result).toHaveLength(1);
      expect(result[0].state).toBe('closed');
    });

    it('should calculate correct lookback date', async () => {
      mockGitHubService.searchIssues.mockResolvedValue([]);
      service.initGitHubService(mockGitHubService as unknown as GitHubService);

      // Mock the current date for consistent testing
      const mockNow = new Date('2024-06-15T12:00:00Z');
      vi.setSystemTime(mockNow);

      await service.fetchRecentlyClosedIssues('test-owner/test-repo', 30);

      // 30 days before 2024-06-15 is 2024-05-16
      expect(mockGitHubService.searchIssues).toHaveBeenCalledWith(
        'test-owner/test-repo',
        'is:issue is:closed label:liveops closed:>2024-05-16'
      );

      vi.useRealTimers();
    });

    it('should return empty array when no closed issues found', async () => {
      mockGitHubService.searchIssues.mockResolvedValue([]);
      service.initGitHubService(mockGitHubService as unknown as GitHubService);

      const result = await service.fetchRecentlyClosedIssues('test-owner/test-repo', 30);

      expect(result).toEqual([]);
    });

    it('should throw when GitHub service not initialized', async () => {
      await expect(service.fetchRecentlyClosedIssues('test-owner/test-repo', 30)).rejects.toThrow(
        'GitHub service not initialized'
      );
    });

    it('should return empty array on error and log the error', async () => {
      mockGitHubService.searchIssues.mockRejectedValue(new Error('API error'));
      service.initGitHubService(mockGitHubService as unknown as GitHubService);

      const result = await service.fetchRecentlyClosedIssues('test-owner/test-repo', 30);

      expect(result).toEqual([]);
      expect(mockLogger.error).toHaveBeenCalledWith('Error fetching recently closed issues:', expect.any(Error));
    });

    it('should log info when closed issues are found', async () => {
      const mockClosedIssues = [
        { number: 1, title: 'Issue 1', state: 'closed', labels: [{ name: 'liveops' }], created_at: '2024-01-01' },
        { number: 2, title: 'Issue 2', state: 'closed', labels: [{ name: 'liveops' }], created_at: '2024-01-02' },
      ];
      mockGitHubService.searchIssues.mockResolvedValue(mockClosedIssues);
      service.initGitHubService(mockGitHubService as unknown as GitHubService);

      await service.fetchRecentlyClosedIssues('test-owner/test-repo', 30);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Found 2 recently closed liveops issues (last 30 days, 0 with fingerprints, 0 with semantic fingerprints)'
      );
    });
  });

  describe('createGitHubIssue', () => {
    beforeEach(() => {
      service.initGitHubService(mockGitHubService as unknown as GitHubService);
      mockGitHubService.ensureLabelExists.mockResolvedValue({ id: 1, name: 'test', color: 'ff0000' });
    });

    it('should ensure labels exist before creating issue', async () => {
      mockGitHubService.createIssue.mockResolvedValue({
        number: 42,
        title: '[LiveOps] Test Error',
        html_url: 'https://github.com/test-owner/test-repo/issues/42',
      });

      await service.createGitHubIssue('test-owner/test-repo', mockTriageResult);

      // Should create liveops label
      expect(mockGitHubService.ensureLabelExists).toHaveBeenCalledWith('test-owner/test-repo', {
        name: 'liveops',
        color: 'f9d0c4',
        description: 'Automated LiveOps triage',
      });

      // Should create priority label
      expect(mockGitHubService.ensureLabelExists).toHaveBeenCalledWith('test-owner/test-repo', {
        name: 'P1',
        color: 'ff7518', // orange for P1
        description: 'Priority P1',
      });
    });

    it('should create issue with correct format', async () => {
      mockGitHubService.createIssue.mockResolvedValue({
        number: 42,
        title: '[LiveOps] Test Error',
        html_url: 'https://github.com/test-owner/test-repo/issues/42',
      });

      const result = await service.createGitHubIssue('test-owner/test-repo', mockTriageResult);

      expect(mockGitHubService.createIssue).toHaveBeenCalledWith('test-owner/test-repo', {
        title: '[LiveOps] Test Error',
        body: expect.stringContaining('## Error Details'),
        labels: ['bug', 'liveops', 'P1'],
      });
      expect(result).toBe(42);
    });

    it('should return null when createIssue returns null', async () => {
      mockGitHubService.createIssue.mockResolvedValue(null);

      const result = await service.createGitHubIssue('test-owner/test-repo', mockTriageResult);

      expect(result).toBeNull();
    });

    it('should log on successful creation', async () => {
      mockGitHubService.createIssue.mockResolvedValue({
        number: 42,
        title: '[LiveOps] Test Error',
        html_url: 'https://github.com/test-owner/test-repo/issues/42',
      });

      await service.createGitHubIssue('test-owner/test-repo', mockTriageResult);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Created GitHub issue #42',
        expect.objectContaining({
          priority: 'P1',
          title: 'Test Error',
          url: 'https://github.com/test-owner/test-repo/issues/42',
        })
      );
    });

    it('should throw when GitHub service not initialized', async () => {
      const freshService = createLiveopsTriageService(logger);

      await expect(freshService.createGitHubIssue('test-owner/test-repo', mockTriageResult)).rejects.toThrow(
        'GitHub service not initialized'
      );
    });

    it('should return null on error and log the error', async () => {
      mockGitHubService.createIssue.mockRejectedValue(new Error('API error'));

      const result = await service.createGitHubIssue('test-owner/test-repo', mockTriageResult);

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to create GitHub issue:', expect.any(Error));
    });
  });

  describe('Priority Colors', () => {
    beforeEach(() => {
      service.initGitHubService(mockGitHubService as unknown as GitHubService);
      mockGitHubService.ensureLabelExists.mockResolvedValue({ id: 1, name: 'test', color: 'ff0000' });
      mockGitHubService.createIssue.mockResolvedValue({
        number: 42,
        title: 'Test',
        html_url: 'https://github.com/test/repo/issues/42',
      });
    });

    it('should use red color for P0', async () => {
      const p0Result = { ...mockTriageResult, priority: 'P0' as const };
      await service.createGitHubIssue('test-owner/test-repo', p0Result);

      expect(mockGitHubService.ensureLabelExists).toHaveBeenCalledWith(
        'test-owner/test-repo',
        expect.objectContaining({
          name: 'P0',
          color: 'd73a4a', // red
        })
      );
    });

    it('should use orange color for P1', async () => {
      const p1Result = { ...mockTriageResult, priority: 'P1' as const };
      await service.createGitHubIssue('test-owner/test-repo', p1Result);

      expect(mockGitHubService.ensureLabelExists).toHaveBeenCalledWith(
        'test-owner/test-repo',
        expect.objectContaining({
          name: 'P1',
          color: 'ff7518', // orange
        })
      );
    });

    it('should use yellow color for P2', async () => {
      const p2Result = { ...mockTriageResult, priority: 'P2' as const };
      await service.createGitHubIssue('test-owner/test-repo', p2Result);

      expect(mockGitHubService.ensureLabelExists).toHaveBeenCalledWith(
        'test-owner/test-repo',
        expect.objectContaining({
          name: 'P2',
          color: 'fbca04', // yellow
        })
      );
    });

    it('should use green color for P3', async () => {
      const p3Result = { ...mockTriageResult, priority: 'P3' as const };
      await service.createGitHubIssue('test-owner/test-repo', p3Result);

      expect(mockGitHubService.ensureLabelExists).toHaveBeenCalledWith(
        'test-owner/test-repo',
        expect.objectContaining({
          name: 'P3',
          color: '0e8a16', // green
        })
      );
    });
  });

  describe('fetchSlackAlerts', () => {
    beforeEach(async () => {
      // Initialize slack client first
      await service.initSlackClient('test-token');
      // Reset and set up the mock
      mockSlackClient.fetchChannelHistoryInTimeWindow.mockReset();
    });

    it('should fetch alerts using time-windowed pagination', async () => {
      mockSlackClient.fetchChannelHistoryInTimeWindow.mockResolvedValue([
        { ts: '1234567890.123456', text: 'Test alert', user: 'U123', type: 'message' },
      ]);

      const lookbackHours = 12;
      await service.fetchSlackAlerts('C123', lookbackHours);

      expect(mockSlackClient.fetchChannelHistoryInTimeWindow).toHaveBeenCalledWith(
        'C123',
        expect.any(String), // oldest
        expect.any(String) // latest
      );

      // Verify timestamps are approximately correct (within 1 second)
      const [, oldest, latest] = mockSlackClient.fetchChannelHistoryInTimeWindow.mock.calls[0];
      const now = Date.now() / 1000;
      expect(parseFloat(oldest)).toBeCloseTo(now - lookbackHours * 60 * 60, -1);
      expect(parseFloat(latest)).toBeCloseTo(now, -1);
    });

    it('should handle empty channel history', async () => {
      mockSlackClient.fetchChannelHistoryInTimeWindow.mockResolvedValue([]);

      const alerts = await service.fetchSlackAlerts('C123', 12);

      expect(alerts).toEqual([]);
    });

    it('should transform all messages to alerts', async () => {
      mockSlackClient.fetchChannelHistoryInTimeWindow.mockResolvedValue([
        { ts: '1234567890.111', text: 'Alert 1', user: 'U1', type: 'message' },
        { ts: '1234567890.222', text: 'Alert 2', user: 'U2', type: 'message' },
        { ts: '1234567890.333', text: 'Alert 3', user: 'U3', type: 'message' },
      ]);

      const alerts = await service.fetchSlackAlerts('C123', 12);

      expect(alerts).toHaveLength(3);
      expect(alerts[0].ts).toBe('1234567890.111');
      expect(alerts[2].ts).toBe('1234567890.333');
    });

    it('should throw error when slack client not initialized', async () => {
      // Create a service without initializing slack client
      const uninitializedService = createLiveopsTriageService(logger);

      await expect(uninitializedService.fetchSlackAlerts('C123', 12)).rejects.toThrow('Slack client not initialized');
    });
  });

  describe('getConfig', () => {
    it('should return config from database', async () => {
      // Create a fresh service to avoid cached mockAdminSettings calls
      const freshService = createLiveopsTriageService(logger);

      // Reset and set up the mock for this specific test
      mockAdminSettings.findOne.mockReset();
      mockAdminSettings.findOne.mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue({
            settingName: 'liveopsTriageConfig',
            settingValue: mockConfig,
          }),
        }),
      });

      const config = await freshService.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.slackChannelId).toBe('C123456');
      expect(config.githubOwner).toBe('test-owner');
      expect(config.githubRepo).toBe('test-repo');
    });

    it('should return default config when not found in database', async () => {
      // Create a fresh service to avoid cached mockAdminSettings calls
      const freshService = createLiveopsTriageService(logger);

      // Reset and set up the mock for this specific test
      mockAdminSettings.findOne.mockReset();
      mockAdminSettings.findOne.mockReturnValue({
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(null),
        }),
      });

      const config = await freshService.getConfig();

      expect(config.enabled).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('LiveOps Triage config not found, using defaults');
    });
  });
});

// Tests for sanitizeErrorMessage - security critical function
describe('sanitizeErrorMessage', () => {
  describe('API Token Redaction', () => {
    it('should redact OpenAI API keys (sk- prefix)', () => {
      const input = 'Error: Invalid API key sk-1234567890abcdefghijklmno';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('Error: Invalid API key [REDACTED_TOKEN]');
    });

    it('should redact Anthropic API keys (sk-ant- prefix)', () => {
      const input = 'Error: sk-ant-api03-abcdefghijklmnopqrstuvwxyz12345';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('Error: [REDACTED_TOKEN]');
    });

    it('should redact Slack tokens (xoxb- prefix)', () => {
      // Short segments: a canonical-length xoxb fixture trips GitHub push
      // protection. Redaction only needs a 20+ char [A-Za-z0-9_-] run with an
      // xox[bsap]- prefix, which this still is.
      const input = 'Slack auth failed: xoxb-123-456-notarealtoken';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('Slack auth failed: [REDACTED_TOKEN]');
    });

    it('should redact GitHub tokens (ghp_ prefix)', () => {
      const input = 'GitHub error with token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345678';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('GitHub error with token [REDACTED_TOKEN]');
    });

    it('should redact AWS Access Key IDs (AKIA prefix)', () => {
      const input = 'AWS credential error: AKIAIOSFODNN7EXAMPLE';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('AWS credential error: [REDACTED_TOKEN]');
    });

    it('should redact Google API keys (AIza prefix)', () => {
      const input = 'Google API error: AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('Google API error: [REDACTED_TOKEN]');
    });

    it('should redact Bearer tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('Authorization: Bearer [REDACTED_TOKEN]');
    });

    it('should redact long strings (>40 chars) that could be secrets', () => {
      const input = 'Error with value: abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('Error with value: [REDACTED_LONG_STRING]');
    });
  });

  describe('PII Redaction', () => {
    it('should redact email addresses', () => {
      const input = 'Error for user john.doe@example.com';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('Error for user [REDACTED_EMAIL]');
    });

    it('should redact IP addresses', () => {
      const input = 'Connection refused from 192.168.1.100';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('Connection refused from [REDACTED_IP]');
    });
  });

  describe('Connection String Redaction', () => {
    it('should redact MongoDB connection strings', () => {
      const input = 'Database error: mongodb+srv://user:pass@cluster.mongodb.net/db';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('Database error: [REDACTED_MONGODB_URI]');
    });

    it('should redact URLs with embedded credentials', () => {
      // Note: The email regex may catch some patterns first (e.g., user@domain)
      // Test verifies that credentials are redacted (email pattern covers this case)
      const input = 'Error connecting to https://user:secret123@api.server.io/endpoint';
      const result = sanitizeErrorMessage(input);
      // The important thing is that the password/credentials pattern is not exposed
      expect(result).not.toContain('secret123');
      expect(result).toContain('[REDACTED');
    });
  });

  describe('Private Key Redaction', () => {
    it('should redact PEM private keys', () => {
      const input = `Error with key: -----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0m59l2u9iDnMbrXH
-----END RSA PRIVATE KEY-----`;
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('Error with key: [REDACTED_PRIVATE_KEY]');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty strings', () => {
      expect(sanitizeErrorMessage('')).toBe('');
    });

    it('should not modify messages without sensitive data', () => {
      const input = 'Simple error message without secrets';
      expect(sanitizeErrorMessage(input)).toBe(input);
    });

    it('should handle multiple secrets in one message', () => {
      const input = 'Error: user test@example.com from 10.0.0.1 with token sk-1234567890abcdefghijklmno';
      const result = sanitizeErrorMessage(input);
      expect(result).toContain('[REDACTED_EMAIL]');
      expect(result).toContain('[REDACTED_IP]');
      expect(result).toContain('[REDACTED_TOKEN]');
    });
  });
});

// Factory functions for checkLLMMatchedClosedIssueRegression tests
function createTestTriageResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    alertId: 'test-alert-123',
    priority: 'P2',
    category: 'api',
    title: 'Test Error',
    body: 'Test body',
    labels: ['bug', 'liveops'],
    matchesExisting: null,
    isRecurring: false,
    occurrenceCount: 1,
    isRegression: false,
    ...overrides,
  };
}

function createTestClosedIssue(overrides: Partial<ExistingIssue> = {}): ExistingIssue {
  return {
    number: 42,
    title: 'Original Issue',
    state: 'closed',
    labels: ['liveops'],
    createdAt: '2024-01-01T00:00:00Z',
    closedAt: '2024-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('checkLLMMatchedClosedIssueRegression', () => {
  const DEFAULT_GRACE_PERIOD_HOURS = 48;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Early Return Cases (return false, no mutation)', () => {
    it('should return false when matchesExisting is null', () => {
      const result = createTestTriageResult({ matchesExisting: null });
      const closedIssues = [createTestClosedIssue()];

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(false);
      expect(result.isRegression).toBe(false);
      expect(result.matchedClosedIssue).toBeUndefined();
    });

    it('should return false when matchesExisting is undefined', () => {
      const result = createTestTriageResult();
      // Explicitly set to undefined to test this branch
      (result as { matchesExisting: undefined }).matchesExisting = undefined;
      const closedIssues = [createTestClosedIssue()];

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(false);
      expect(result.isRegression).toBe(false);
    });

    it('should return false when isRegression is already true', () => {
      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
        isRegression: true,
      });
      const closedIssues = [createTestClosedIssue({ number: 42 })];

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(false);
      // Should not modify anything since already marked as regression
      expect(result.matchesExisting).toEqual({ issueNumber: 42, title: 'Original Issue' });
    });

    it('should return false when matched issue not in recentlyClosedIssues', () => {
      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 999, title: 'Non-existent Issue' },
      });
      const closedIssues = [createTestClosedIssue({ number: 42 })]; // Different issue number

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(false);
      expect(result.isRegression).toBe(false);
      expect(result.matchesExisting).toEqual({ issueNumber: 999, title: 'Non-existent Issue' });
    });

    it('should return false when closedAt is undefined', () => {
      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
      });
      const closedIssues = [createTestClosedIssue({ number: 42, closedAt: undefined })];

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(false);
      expect(result.isRegression).toBe(false);
    });

    it('should return false when closedAt is empty string', () => {
      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
      });
      const closedIssues = [createTestClosedIssue({ number: 42, closedAt: '' })];

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(false);
      expect(result.isRegression).toBe(false);
    });

    it('should return false when closedAt is invalid date string', () => {
      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
      });
      const closedIssues = [createTestClosedIssue({ number: 42, closedAt: 'not-a-date' })];

      // Invalid date produces NaN, and NaN comparisons are always false
      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(false);
      expect(result.isRegression).toBe(false);
    });
  });

  // When the LLM flags isRegression with a matchedClosedIssue but omits
  // closedAt, enrich it from the real GitHub source so the downstream
  // Slack/GitHub formatters render a real date instead of a fallback.
  describe('LLM-set regression closedAt enrichment', () => {
    it('enriches a null closedAt from the matching GitHub source issue', () => {
      const result = createTestTriageResult({
        isRegression: true,
        matchedClosedIssue: { issueNumber: 42, title: 'Original Issue', closedAt: null },
      });
      const closedIssues = [createTestClosedIssue({ number: 42, closedAt: '2024-03-04T00:00:00Z' })];

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      // Enrichment is a side mutation; it does not "newly mark" a regression.
      expect(wasUpdated).toBe(false);
      expect(result.matchedClosedIssue?.closedAt).toBe('2024-03-04T00:00:00Z');
    });

    it('leaves an already-present closedAt untouched', () => {
      const result = createTestTriageResult({
        isRegression: true,
        matchedClosedIssue: { issueNumber: 42, title: 'Original Issue', closedAt: '2024-01-02T00:00:00Z' },
      });
      const closedIssues = [createTestClosedIssue({ number: 42, closedAt: '2024-09-09T00:00:00Z' })];

      checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(result.matchedClosedIssue?.closedAt).toBe('2024-01-02T00:00:00Z');
    });

    it('is a no-op when the matched issue is not in recentlyClosedIssues', () => {
      const result = createTestTriageResult({
        isRegression: true,
        matchedClosedIssue: { issueNumber: 999, title: 'Original Issue', closedAt: null },
      });
      const closedIssues = [createTestClosedIssue({ number: 42, closedAt: '2024-03-04T00:00:00Z' })];

      checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(result.matchedClosedIssue?.closedAt).toBeNull();
    });
  });

  describe('Grace Period Logic', () => {
    it('should return false when within grace period', () => {
      // Issue closed 24 hours ago, grace period is 48 hours -> within grace period
      const closedAt = new Date('2024-01-10T12:00:00Z');
      const currentTime = new Date('2024-01-11T12:00:00Z'); // 24 hours later
      vi.setSystemTime(currentTime);

      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
      });
      const closedIssues = [createTestClosedIssue({ number: 42, closedAt: closedAt.toISOString() })];

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(false);
      expect(result.isRegression).toBe(false);
      expect(result.matchesExisting).toEqual({ issueNumber: 42, title: 'Original Issue' }); // Unchanged
    });

    it('should return false when exactly at grace period boundary', () => {
      // Issue closed exactly 48 hours ago, grace period is 48 hours
      // Date.now() - closedAt > gracePeriodMs uses > (not >=), so exactly at boundary returns false
      const closedAt = new Date('2024-01-10T12:00:00Z');
      const currentTime = new Date('2024-01-12T12:00:00Z'); // Exactly 48 hours later
      vi.setSystemTime(currentTime);

      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
      });
      const closedIssues = [createTestClosedIssue({ number: 42, closedAt: closedAt.toISOString() })];

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(false);
      expect(result.isRegression).toBe(false);
    });

    it('should return true when past grace period', () => {
      // Issue closed 72 hours ago, grace period is 48 hours -> past grace period
      const closedAt = new Date('2024-01-10T12:00:00Z');
      const currentTime = new Date('2024-01-13T12:00:00Z'); // 72 hours later
      vi.setSystemTime(currentTime);

      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
      });
      const closedIssues = [createTestClosedIssue({ number: 42, closedAt: closedAt.toISOString() })];

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(true);
    });
  });

  describe('Mutation Verification (when returning true)', () => {
    const closedAt = new Date('2024-01-10T12:00:00Z');
    const currentTime = new Date('2024-01-13T12:00:00Z'); // 72 hours later (past 48h grace period)

    beforeEach(() => {
      vi.setSystemTime(currentTime);
    });

    it('should set isRegression to true', () => {
      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
        isRegression: false,
      });
      const closedIssues = [createTestClosedIssue({ number: 42, closedAt: closedAt.toISOString() })];

      checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(result.isRegression).toBe(true);
    });

    it('should set matchedClosedIssue with correct metadata', () => {
      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
      });
      const closedIssues = [
        createTestClosedIssue({
          number: 42,
          title: 'Closed Bug Fix',
          closedAt: closedAt.toISOString(),
        }),
      ];

      checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(result.matchedClosedIssue).toEqual({
        issueNumber: 42,
        title: 'Closed Bug Fix',
        closedAt: closedAt.toISOString(),
      });
    });

    it('should clear matchesExisting to null', () => {
      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
      });
      expect(result.matchesExisting).not.toBeNull(); // Pre-condition

      const closedIssues = [createTestClosedIssue({ number: 42, closedAt: closedAt.toISOString() })];

      checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(result.matchesExisting).toBeNull();
    });
  });

  describe('Data Integrity', () => {
    it('should not mutate result when returning false', () => {
      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
        isRegression: false,
      });
      const originalSnapshot = JSON.parse(JSON.stringify(result));

      // Case: Issue not in closed issues list
      const closedIssues = [createTestClosedIssue({ number: 999 })]; // Different issue number

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, closedIssues, DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(false);
      expect(result).toEqual(originalSnapshot);
    });

    it('should handle empty recentlyClosedIssues array', () => {
      const result = createTestTriageResult({
        matchesExisting: { issueNumber: 42, title: 'Original Issue' },
      });

      const wasUpdated = checkLLMMatchedClosedIssueRegression(result, [], DEFAULT_GRACE_PERIOD_HOURS);

      expect(wasUpdated).toBe(false);
      expect(result.isRegression).toBe(false);
    });
  });

  describe('REQUIRED_GITHUB_LABELS', () => {
    it('should include all expected labels', () => {
      const labelNames = REQUIRED_GITHUB_LABELS.map(l => l.name);
      expect(labelNames).toContain('bug');
      expect(labelNames).toContain('liveops');
      expect(labelNames).toContain('P0');
      expect(labelNames).toContain('P1');
      expect(labelNames).toContain('P2');
      expect(labelNames).toContain('P3');
      expect(labelNames).toContain('regression');
    });

    it('should support case-insensitive matching', () => {
      // Simulate GitHub returning labels with different casing
      const repoLabels = ['Bug', 'LIVEOPS', 'p0', 'p1', 'p2', 'p3', 'Regression'];
      const repoLabelsLower = repoLabels.map(l => l.toLowerCase());

      const missingLabels = REQUIRED_GITHUB_LABELS.filter(l => !repoLabelsLower.includes(l.name.toLowerCase()));

      expect(missingLabels).toHaveLength(0);
    });

    it('should detect missing labels with case-insensitive comparison', () => {
      const repoLabels = ['Bug', 'liveops']; // Missing P0-P3 and regression
      const repoLabelsLower = repoLabels.map(l => l.toLowerCase());

      const missingLabels = REQUIRED_GITHUB_LABELS.filter(l => !repoLabelsLower.includes(l.name.toLowerCase()));

      expect(missingLabels).toHaveLength(5); // P0, P1, P2, P3, regression
      const missingNames = missingLabels.map(l => l.name);
      expect(missingNames).toContain('P0');
      expect(missingNames).toContain('P1');
      expect(missingNames).toContain('P2');
      expect(missingNames).toContain('P3');
      expect(missingNames).toContain('regression');
    });

    it('should have valid color codes for all labels', () => {
      for (const label of REQUIRED_GITHUB_LABELS) {
        expect(label.color).toMatch(/^[0-9a-f]{6}$/);
        expect(label.description).toBeTruthy();
      }
    });
  });
});
