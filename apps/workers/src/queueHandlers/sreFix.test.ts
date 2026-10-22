import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatch } from './sreFix';

// Mock dependencies
const mockGetSettingsValue = vi.fn();
const mockUpdateStatus = vi.fn();
const mockClaimDispatch = vi.fn();
const mockCountConsecutiveFailures = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
  },
  sreErrorTrackingRepository: {
    updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
    claimDispatch: (...args: unknown[]) => mockClaimDispatch(...args),
    countConsecutiveFailures: (...args: unknown[]) => mockCountConsecutiveFailures(...args),
  },
}));

const mockCreateDispatchEvent = vi.fn();
vi.mock('@server/services/githubService', () => ({
  GitHubService: {
    forSystem: vi.fn().mockResolvedValue({
      createDispatchEvent: (...args: unknown[]) => mockCreateDispatchEvent(...args),
    }),
  },
}));

const mockResolvedRepoConfig = {
  enabled: true,
  dryRun: false,
  reviewers: '',
  defaultBranch: 'main',
  buildCommand: '',
  allowedFilePatterns: [],
  blockedFilePatterns: [],
  circuitBreaker: { failureThreshold: 3, cooldownMinutes: 30 },
  maxFixesPerDay: 5,
  tokenBudget: { maxGithubApiCalls: 50 },
  slack: {},
  owner: 'MillionOnMars',
  repo: 'lumina5',
};

vi.mock('@bike4mind/common', () => ({
  SreSourceType: { CLOUDWATCH: 'CLOUDWATCH', GITHUB_ISSUE: 'GITHUB_ISSUE' },
  SRE_ANALYSIS_COMPLETED_EVENT: 'sre.analysis.completed',
  SRE_DEFAULT_REPO_SLUG: 'MillionOnMars/lumina5',
  SRE_TEST_FILE_GLOBS: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
  resolveFullConfig: vi.fn(() => mockResolvedRepoConfig),
  SreAgentConfigSchema: {
    parse: vi.fn((v: unknown) => ({
      repos: [],
      ...(v as Record<string, unknown>),
    })),
  },
}));

vi.mock('@bike4mind/observability', () => {
  const mockLogger: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    updateMetadata: vi.fn(),
  };
  mockLogger.withMetadata = vi.fn(() => mockLogger);
  return {
    Logger: vi.fn(() => mockLogger),
  };
});

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('@server/integrations/slack/sreSlackApproval', () => ({
  postSreFixFailureMessage: vi.fn().mockResolvedValue(undefined),
}));

function makeSqsEvent(body: Record<string, unknown>) {
  return { Records: [{ body: JSON.stringify(body) }] };
}

// EventBridge rule targets deliver the full event envelope (infra/eventBus.ts)
function makeEventBridgeSqsEvent(detail: Record<string, unknown>) {
  return makeSqsEvent({
    version: '0',
    id: 'evt-1',
    'detail-type': 'sre.analysis.completed',
    source: 'bike4mind',
    detail,
  });
}

function makeFixRequest(overrides: Record<string, unknown> = {}) {
  return {
    trackingId: 'track-123',
    fingerprint: 'fp-abc12345',
    diagnosis: {
      rootCause: 'test',
      proposedFix: 'fix',
      confidence: 80,
      riskAssessment: 'low',
      affectedFiles: [{ filePath: 'test.ts', before: 'a', after: 'b' }],
    },
    source: 'CLOUDWATCH',
    ...overrides,
  };
}

const mockContext = {} as never;
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

describe('sreFix handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_URL = 'https://test.example.com';
    mockGetSettingsValue.mockResolvedValue({ enabled: true });
    mockCountConsecutiveFailures.mockResolvedValue(0);
    mockClaimDispatch.mockResolvedValue({ _id: 'track-123' });
    mockCreateDispatchEvent.mockResolvedValue(undefined);
    mockUpdateStatus.mockResolvedValue(undefined);
  });

  describe('EventBridge envelope unwrap', () => {
    it('unwraps the detail payload when delivered via the sre.analysis.completed rule', async () => {
      await dispatch(makeEventBridgeSqsEvent(makeFixRequest()), mockContext, mockLogger);

      expect(mockClaimDispatch).toHaveBeenCalledWith('track-123');
      expect(mockCreateDispatchEvent).toHaveBeenCalled();
    });

    it('still accepts bare payloads from direct SQS producers (approval/revision paths)', async () => {
      await dispatch(makeSqsEvent(makeFixRequest()), mockContext, mockLogger);

      expect(mockClaimDispatch).toHaveBeenCalledWith('track-123');
      expect(mockCreateDispatchEvent).toHaveBeenCalled();
    });
  });

  describe('circuit breaker', () => {
    it('should skip dispatch when circuit breaker is open', async () => {
      mockCountConsecutiveFailures.mockResolvedValue(5);

      await dispatch(makeSqsEvent(makeFixRequest()), mockContext, mockLogger);

      expect(mockUpdateStatus).toHaveBeenCalledWith('track-123', 'failed', {
        errorMessage: expect.stringContaining('Circuit breaker open'),
      });
      expect(mockClaimDispatch).not.toHaveBeenCalled();
      expect(mockCreateDispatchEvent).not.toHaveBeenCalled();
    });

    it('should proceed normally when circuit breaker is closed', async () => {
      mockCountConsecutiveFailures.mockResolvedValue(1);

      await dispatch(makeSqsEvent(makeFixRequest()), mockContext, mockLogger);

      expect(mockClaimDispatch).toHaveBeenCalled();
    });
  });

  describe('dispatch idempotency', () => {
    it('should set githubRunDispatched and dispatch on first invocation', async () => {
      await dispatch(makeSqsEvent(makeFixRequest()), mockContext, mockLogger);

      expect(mockClaimDispatch).toHaveBeenCalledWith('track-123');
      expect(mockCreateDispatchEvent).toHaveBeenCalled();
    });

    it('should include callbackUrl from APP_URL in dispatch payload', async () => {
      await dispatch(makeSqsEvent(makeFixRequest()), mockContext, mockLogger);

      expect(mockCreateDispatchEvent).toHaveBeenCalledWith(
        expect.any(String),
        'sre-autofix',
        expect.objectContaining({
          callbackUrl: 'https://test.example.com',
        })
      );
    });

    it('should skip dispatch on SQS retry (flag already set)', async () => {
      mockClaimDispatch.mockResolvedValue(null);

      await dispatch(makeSqsEvent(makeFixRequest()), mockContext, mockLogger);

      expect(mockCreateDispatchEvent).not.toHaveBeenCalled();
    });

    it('should NOT re-throw on dispatch failure', async () => {
      mockCreateDispatchEvent.mockRejectedValue(new Error('GitHub API down'));

      // Should not throw
      await dispatch(makeSqsEvent(makeFixRequest()), mockContext, mockLogger);

      expect(mockUpdateStatus).toHaveBeenCalledWith('track-123', 'dispatch_failed', {
        errorMessage: 'GitHub API down',
      });
    });
  });

  describe('revision dispatch', () => {
    function makeRevisionRequest(overrides: Record<string, unknown> = {}) {
      return makeFixRequest({
        revision: {
          branchName: 'sre-fix/abc123-xyz',
          prNumber: 42,
          revisionCount: 1,
        },
        ...overrides,
      });
    }

    it('dispatches sre-autofix-revision event type for revisions', async () => {
      await dispatch(makeSqsEvent(makeRevisionRequest()), mockContext, mockLogger);

      expect(mockCreateDispatchEvent).toHaveBeenCalledWith(
        expect.any(String),
        'sre-autofix-revision',
        expect.objectContaining({
          branchName: 'sre-fix/abc123-xyz',
        })
      );
    });

    it('uses existing branch name instead of generating a new one', async () => {
      await dispatch(makeSqsEvent(makeRevisionRequest()), mockContext, mockLogger);

      expect(mockCreateDispatchEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          branchName: 'sre-fix/abc123-xyz',
        })
      );
    });

    it('packs revisionCount and prNumber into meta JSON', async () => {
      await dispatch(makeSqsEvent(makeRevisionRequest()), mockContext, mockLogger);

      const dispatchCall = mockCreateDispatchEvent.mock.calls[0];
      const payload = dispatchCall[2];
      const meta = JSON.parse(payload.meta);

      expect(meta.revisionCount).toBe(1);
      expect(meta.prNumber).toBe(42);
    });

    it('dispatches sre-autofix for non-revision requests', async () => {
      await dispatch(makeSqsEvent(makeFixRequest()), mockContext, mockLogger);

      expect(mockCreateDispatchEvent).toHaveBeenCalledWith(
        expect.any(String),
        'sre-autofix',
        expect.objectContaining({
          branchName: expect.stringMatching(/^sre-fix\//),
        })
      );
    });
  });

  describe('blockTestEdits — Rule 2 test-glob injection', () => {
    it('appends test globs to meta.blockedFilePatterns when blockTestEdits is set (CI self-heal)', async () => {
      await dispatch(makeSqsEvent(makeFixRequest({ blockTestEdits: true })), mockContext, mockLogger);

      const meta = JSON.parse(mockCreateDispatchEvent.mock.calls[0][2].meta);
      expect(meta.blockedFilePatterns).toEqual(
        expect.arrayContaining(['**/*.test.*', '**/*.spec.*', '**/__tests__/**'])
      );
    });

    it('does NOT inject test globs for a normal (initial) fix request', async () => {
      await dispatch(makeSqsEvent(makeFixRequest()), mockContext, mockLogger);

      const meta = JSON.parse(mockCreateDispatchEvent.mock.calls[0][2].meta);
      // repoConfig.blockedFilePatterns is [] and blockTestEdits is unset -> key omitted entirely
      expect(meta.blockedFilePatterns).toBeUndefined();
    });
  });
});
