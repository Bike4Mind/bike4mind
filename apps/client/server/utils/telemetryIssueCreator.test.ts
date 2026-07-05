// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContextTelemetry, AnomaliesTelemetry } from '@bike4mind/common';
import { getFallbackPriority, createTelemetryIssue } from './telemetryIssueCreator';
import { Logger } from '@bike4mind/observability';

vi.mock('@server/services/githubService', () => ({
  GitHubService: {
    forSystem: vi.fn(),
  },
}));

vi.mock('@bike4mind/database', () => ({
  Quest: { updateOne: vi.fn().mockResolvedValue({}) },
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(null) },
  cacheRepository: { claimDedup: vi.fn().mockResolvedValue({ claimed: true }) },
}));

vi.mock('@server/services/telemetryFingerprint', () => ({
  generateTelemetryFingerprint: vi.fn().mockReturnValue('fp-abc123'),
  generateSemanticTelemetryFingerprint: vi.fn().mockReturnValue('sfp-def456'),
  extractFingerprintFromBody: vi.fn().mockReturnValue(null),
  extractSemanticFingerprintFromBody: vi.fn().mockReturnValue(null),
  getSeverityEmoji: vi.fn().mockReturnValue('🟡'),
  formatPrimaryAnomaly: vi.fn((s: string) => s.replace('_', ' ')),
}));

vi.mock('@server/utils/markdownEscape', () => ({
  escapeMarkdown: vi.fn((s: string) => s),
}));

vi.mock('@server/services/issueDedup', () => ({
  checkFingerprintDedup: vi.fn().mockReturnValue({
    isDuplicate: false,
    isRegression: false,
  }),
}));

vi.mock('@server/utils/telemetryAnalysis', () => ({
  computeHistoricalBaselines: vi.fn().mockResolvedValue(null),
  generateRuleBasedAnalysis: vi.fn().mockReturnValue({
    summary: 'Test analysis',
    findings: ['finding1'],
    recommendations: ['rec1'],
    estimatedImpact: 'low',
  }),
  generateLLMAnalysis: vi.fn(),
  formatIssueBody: vi.fn().mockReturnValue('Issue body content'),
  DEFAULT_SLOS: {
    sloResponseTimeP95Ms: 60000,
    sloFirstTokenTimeMs: 5000,
    sloErrorRatePercent: 2,
    sloContextUtilizationPercent: 85,
  },
}));

function createTestTelemetry(
  overrides: {
    anomalies?: Partial<AnomaliesTelemetry>;
    model?: { modelId?: string; provider?: string };
  } = {}
): ContextTelemetry {
  const defaultAnomalies: AnomaliesTelemetry = {
    contextOverflow: false,
    highUtilization: false,
    criticalUtilization: false,
    highTruncation: false,
    criticalTruncation: false,
    toolFailureSpike: false,
    toolTimeout: false,
    subagentTimeout: false,
    slowFirstToken: false,
    slowTotalResponse: false,
    anomalyScore: 30,
    severity: 'medium',
    dedupKey: 'test-key',
    primaryAnomaly: 'slow_response',
  };

  return {
    schemaVersion: '1.0',
    timestamp: new Date().toISOString(),
    captureOverheadMs: 10,
    anonymousSessionId: { hash: 'test-hash', dateKey: '2025-01-01' },
    operation: { name: 'chat_completion' },
    model: {
      modelId: overrides.model?.modelId ?? 'claude-3-5-sonnet-20241022',
      provider: (overrides.model?.provider as 'anthropic') ?? 'anthropic',
      fallbackUsed: false,
      usedThinking: false,
      usedTools: false,
    },
    systemPrompts: { prompts: [], totalTokens: 0, duplicateCount: 0 },
    features: { contributions: [] },
    contextWindow: {
      inputTokens: 1000,
      outputTokens: 500,
      contextWindowLimit: 200000,
      utilizationPercentage: 0.5,
      reservedOutputTokens: 8000,
      overflowDetected: false,
      tokensBySource: {
        systemPrompts: 100,
        conversationHistory: 400,
        mementos: 100,
        fabFiles: 100,
        urlContent: 100,
        toolSchemas: 100,
        userPrompt: 100,
      },
    },
    costs: {
      inputCostUsd: 0.01,
      outputCostUsd: 0.02,
      totalCostUsd: 0.03,
      creditsUsed: 1,
    },
    truncation: {
      wasTruncated: false,
      originalMessageCount: 10,
      finalMessageCount: 10,
      truncatedMessageCount: 0,
      truncationPercentage: 0,
    },
    performance: {
      totalResponseTimeMs: 5000,
    },
    anomalies: { ...defaultAnomalies, ...overrides.anomalies },
    requestMetadata: {
      queryComplexity: 'simple',
      historyMessageCount: 5,
      attachedFileCount: 0,
      mementoCount: 0,
      enabledFeatures: [],
    },
  };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    updateMetadata: vi.fn(),
  } as unknown as Logger;
}

describe('getFallbackPriority', () => {
  it('returns P0 for critical severity with score >= 70', () => {
    const telemetry = createTestTelemetry({
      anomalies: { severity: 'critical', anomalyScore: 85 },
    });
    expect(getFallbackPriority(telemetry)).toBe('P0');
  });

  it('returns P0 for critical severity with score exactly 70', () => {
    const telemetry = createTestTelemetry({
      anomalies: { severity: 'critical', anomalyScore: 70 },
    });
    expect(getFallbackPriority(telemetry)).toBe('P0');
  });

  it('returns P1 for critical severity with score < 70', () => {
    const telemetry = createTestTelemetry({
      anomalies: { severity: 'critical', anomalyScore: 65 },
    });
    expect(getFallbackPriority(telemetry)).toBe('P1');
  });

  it('returns P1 for high severity with score >= 60', () => {
    const telemetry = createTestTelemetry({
      anomalies: { severity: 'high', anomalyScore: 60 },
    });
    expect(getFallbackPriority(telemetry)).toBe('P1');
  });

  it('returns P2 for high severity with score < 60', () => {
    const telemetry = createTestTelemetry({
      anomalies: { severity: 'high', anomalyScore: 55 },
    });
    expect(getFallbackPriority(telemetry)).toBe('P2');
  });

  it('returns P3 for medium severity', () => {
    const telemetry = createTestTelemetry({
      anomalies: { severity: 'medium', anomalyScore: 35 },
    });
    expect(getFallbackPriority(telemetry)).toBe('P3');
  });

  it('returns P3 for low severity', () => {
    const telemetry = createTestTelemetry({
      anomalies: { severity: 'low', anomalyScore: 10 },
    });
    expect(getFallbackPriority(telemetry)).toBe('P3');
  });
});

// Import mocked modules for type-safe access in tests
import { GitHubService } from '@server/services/githubService';
import { checkFingerprintDedup } from '@server/services/issueDedup';
import { cacheRepository } from '@bike4mind/database';

const mockedGitHubService = vi.mocked(GitHubService);
const mockedCheckDedup = vi.mocked(checkFingerprintDedup);
const mockedCacheRepo = vi.mocked(cacheRepository);

describe('createTelemetryIssue', () => {
  const mockGithubService = {
    listIssues: vi.fn().mockResolvedValue([]),
    listLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue(null),
    createIssue: vi.fn().mockResolvedValue({
      number: 42,
      title: 'Test issue',
      html_url: 'https://github.com/test/repo/issues/42',
      state: 'open',
      labels: [
        { name: 'bug', color: '' },
        { name: 'telemetry', color: '' },
      ],
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGitHubService.forSystem.mockResolvedValue(mockGithubService);
    mockedCheckDedup.mockReturnValue({
      isDuplicate: false,
      isRegression: false,
    });
    mockedCacheRepo.claimDedup.mockResolvedValue({ claimed: true });
    mockGithubService.listIssues.mockResolvedValue([]);
    mockGithubService.createIssue.mockResolvedValue({
      number: 42,
      title: 'Test issue',
      html_url: 'https://github.com/test/repo/issues/42',
      state: 'open',
      labels: [
        { name: 'bug', color: '' },
        { name: 'telemetry', color: '' },
      ],
    });
  });

  it('returns NO_GITHUB_CONNECTION when GitHubService.forSystem returns null', async () => {
    mockedGitHubService.forSystem.mockResolvedValue(null);

    const result = await createTelemetryIssue({
      telemetry: createTestTelemetry(),
      repository: 'owner/repo',
      sourcePrefix: 'manual',
      logger: createMockLogger(),
    });

    expect(result).toEqual({
      status: 'error',
      code: 'NO_GITHUB_CONNECTION',
      message: expect.stringContaining('GitHub integration not configured'),
    });
  });

  it('returns INVALID_REPO_FORMAT for malformed repository', async () => {
    const result = await createTelemetryIssue({
      telemetry: createTestTelemetry(),
      repository: 'not-a-valid-repo',
      sourcePrefix: 'manual',
      logger: createMockLogger(),
    });

    expect(result).toEqual({
      status: 'error',
      code: 'INVALID_REPO_FORMAT',
      message: expect.stringContaining('Invalid repository format'),
    });
  });

  it('returns REPO_NOT_ALLOWED when githubService.createIssue returns null', async () => {
    mockGithubService.createIssue.mockResolvedValue(null);

    const result = await createTelemetryIssue({
      telemetry: createTestTelemetry(),
      repository: 'owner/repo',
      sourcePrefix: 'manual',
      skipDedup: true,
      precomputedDedup: { isRegression: false },
      precomputedAnalysis: {
        analysis: { summary: 'test', findings: [], recommendations: [], estimatedImpact: 'low' },
        source: 'manual-rule-based',
        baselines: null,
      },
      logger: createMockLogger(),
    });

    expect(result).toEqual({
      status: 'error',
      code: 'REPO_NOT_ALLOWED',
      message: expect.stringContaining('not in the allowed list'),
    });
  });

  it('creates issue successfully with precomputed analysis (auto-create path)', async () => {
    const result = await createTelemetryIssue({
      telemetry: createTestTelemetry(),
      repository: 'owner/repo',
      sourcePrefix: 'auto',
      skipDedup: true,
      precomputedDedup: { isRegression: false },
      precomputedAnalysis: {
        analysis: { summary: 'test', findings: ['f1'], recommendations: ['r1'], estimatedImpact: 'low' },
        source: 'auto-llm',
        baselines: null,
      },
      logger: createMockLogger(),
    });

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.issue.number).toBe(42);
      expect(result.hasAnalysis).toBe(true);
      expect(result.analysisSource).toBe('auto-llm');
    }
  });

  it('creates issue with rule-based analysis when no LLM configured (manual path)', async () => {
    const result = await createTelemetryIssue({
      telemetry: createTestTelemetry(),
      repository: 'owner/repo',
      sourcePrefix: 'manual',
      skipDedup: true,
      precomputedDedup: { isRegression: false },
      logger: createMockLogger(),
    });

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.hasAnalysis).toBe(true);
      expect(result.analysisSource).toBe('manual-rule-based');
    }
  });

  it('returns duplicate when dedup check finds matching open issue', async () => {
    mockedCheckDedup.mockReturnValue({
      isDuplicate: true,
      matchedIssue: {
        number: 99,
        title: 'Existing issue',
        state: 'open',
        body: null,
        closedAt: null,
        fingerprint: 'fp-abc123',
        semanticFingerprint: null,
      },
      isRegression: false,
    });

    const result = await createTelemetryIssue({
      telemetry: createTestTelemetry(),
      repository: 'owner/repo',
      sourcePrefix: 'manual',
      logger: createMockLogger(),
    });

    expect(result.status).toBe('duplicate');
    if (result.status === 'duplicate') {
      expect(result.existingIssue.number).toBe(99);
      expect(result.existingIssue.html_url).toContain('/issues/99');
    }
  });

  it('creates regression issue when dedup detects closed match', async () => {
    mockedCheckDedup.mockReturnValue({
      isDuplicate: false,
      isRegression: true,
      matchedClosedIssue: {
        number: 50,
        title: 'Old issue',
        state: 'closed',
        body: null,
        closedAt: '2025-01-01',
        fingerprint: 'fp-abc123',
        semanticFingerprint: null,
      },
    });

    const result = await createTelemetryIssue({
      telemetry: createTestTelemetry(),
      repository: 'owner/repo',
      sourcePrefix: 'manual',
      logger: createMockLogger(),
    });

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.isRegression).toBe(true);
    }
  });

  it('skips dedup when skipDedup is true', async () => {
    const result = await createTelemetryIssue({
      telemetry: createTestTelemetry(),
      repository: 'owner/repo',
      sourcePrefix: 'manual',
      skipDedup: true,
      precomputedDedup: { isRegression: false },
      logger: createMockLogger(),
    });

    expect(result.status).toBe('created');
    expect(mockedCheckDedup).not.toHaveBeenCalled();
  });

  it('returns duplicate when atomic claim fails (race condition)', async () => {
    mockedCacheRepo.claimDedup.mockResolvedValue({ claimed: false });

    const result = await createTelemetryIssue({
      telemetry: createTestTelemetry(),
      repository: 'owner/repo',
      sourcePrefix: 'manual',
      skipDedup: true,
      precomputedDedup: { isRegression: false },
      precomputedAnalysis: {
        analysis: { summary: 'test', findings: [], recommendations: [], estimatedImpact: 'low' },
        source: 'manual-rule-based',
        baselines: null,
      },
      logger: createMockLogger(),
    });

    expect(result.status).toBe('duplicate');
    expect(mockGithubService.createIssue).not.toHaveBeenCalled();
  });

  it('returns GITHUB_API_ERROR when createIssue throws', async () => {
    mockGithubService.createIssue.mockRejectedValue(new Error('API rate limit exceeded'));

    const result = await createTelemetryIssue({
      telemetry: createTestTelemetry(),
      repository: 'owner/repo',
      sourcePrefix: 'manual',
      skipDedup: true,
      precomputedDedup: { isRegression: false },
      precomputedAnalysis: {
        analysis: { summary: 'test', findings: [], recommendations: [], estimatedImpact: 'low' },
        source: 'manual-rule-based',
        baselines: null,
      },
      logger: createMockLogger(),
    });

    expect(result).toEqual({
      status: 'error',
      code: 'GITHUB_API_ERROR',
      message: expect.stringContaining('API rate limit exceeded'),
    });
  });
});
