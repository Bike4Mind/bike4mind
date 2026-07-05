import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSettingsValue = vi.fn();
const mockAtomicTransition = vi.fn();
const mockCountConsecutiveFailures = vi.fn();
const mockCountFixesDispatchedToday = vi.fn();
const mockFindByPrNumber = vi.fn();
const mockDeleteByKey = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
  },
  apiKeyRepository: {},
  cacheRepository: {
    deleteByKey: (...args: unknown[]) => mockDeleteByKey(...args),
  },
  sreErrorTrackingRepository: {
    atomicTransition: (...args: unknown[]) => mockAtomicTransition(...args),
    countConsecutiveFailures: (...args: unknown[]) => mockCountConsecutiveFailures(...args),
    countFixesDispatchedToday: (...args: unknown[]) => mockCountFixesDispatchedToday(...args),
    findByPrNumber: (...args: unknown[]) => mockFindByPrNumber(...args),
  },
}));

const mockRevise = vi.fn();
vi.mock('@bike4mind/services/sreAgentService', () => ({
  SreAgentService: class {
    revise(...args: unknown[]) {
      return mockRevise(...args);
    }
  },
}));

vi.mock('@bike4mind/services/sreAgentService/tools', () => ({
  RATE_LIMITED_SENTINEL: 'GitHub code-search rate limited',
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: {
    getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}),
  },
}));

const mockHasCommentWithMarker = vi.fn();
const mockAddIssueComment = vi.fn();
vi.mock('@server/services/githubService', () => ({
  GitHubService: {
    forSystem: vi.fn().mockResolvedValue({
      getFileContent: vi.fn(),
      searchCode: vi.fn(),
      listDirectoryContents: vi.fn(),
      hasCommentWithMarker: (...args: unknown[]) => mockHasCommentWithMarker(...args),
      addIssueComment: (...args: unknown[]) => mockAddIssueComment(...args),
    }),
  },
  GitHubRateLimitError: class GitHubRateLimitError extends Error {},
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
  SRE_DEFAULT_REPO_SLUG: 'MillionOnMars/lumina5',
  resolveFullConfig: vi.fn(() => mockResolvedRepoConfig),
  SreAgentConfigSchema: {
    parse: vi.fn((v: unknown) => ({ repos: [], ...(v as Record<string, unknown>) })),
  },
  SreClassification: { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' },
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

vi.mock('@bike4mind/utils', () => ({
  getSettingsByNames: vi.fn().mockResolvedValue({}),
}));

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const mockSendToQueue = vi.fn();
vi.mock('@server/utils/sqs', () => ({
  sendToQueue: (...args: unknown[]) => mockSendToQueue(...args),
}));

vi.mock('sst', () => ({
  Resource: { sreFixQueue: { url: 'https://sqs.example.com/sreFixQueue' } },
}));

const mockPostSreNoFixNeededMessage = vi.fn();
const mockPostSreRevisionStartedMessage = vi.fn();
const mockPostSreFixFailureMessage = vi.fn();
const mockPostSreAnalysisFailureMessage = vi.fn();
const mockPostSreRateLimitedMessage = vi.fn();
vi.mock('@server/integrations/slack/sreSlackApproval', () => ({
  postSreNoFixNeededMessage: (...args: unknown[]) => mockPostSreNoFixNeededMessage(...args),
  postSreRevisionStartedMessage: (...args: unknown[]) => mockPostSreRevisionStartedMessage(...args),
  postSreFixFailureMessage: (...args: unknown[]) => mockPostSreFixFailureMessage(...args),
  postSreAnalysisFailureMessage: (...args: unknown[]) => mockPostSreAnalysisFailureMessage(...args),
  postSreRateLimitedMessage: (...args: unknown[]) => mockPostSreRateLimitedMessage(...args),
}));

import { runSreRevision } from './sreRevision';

// The legacy sreRevisionQueue entrypoint was removed when the queue was merged
// into sreJobQueue; the revision logic now lives in runSreRevision. This
// adapter preserves the existing (event, ctx, logger) call sites below - it parses
// the SQS body and invokes the extracted function, mirroring what the merged
// sreJob handler does for jobType: 'revision'.
function dispatch(event: { Records: { body: string }[] }, _ctx: unknown, logger: unknown) {
  return runSreRevision(JSON.parse(event.Records[0].body), logger as never);
}

function makeSqsEvent(body: Record<string, unknown>) {
  return { Records: [{ body: JSON.stringify(body) }] };
}

function makeRevisionRequest(overrides: Record<string, unknown> = {}) {
  return {
    // Mirror the on-the-wire shape: producers tag revision messages with jobType
    // and the sreJob handler routes on it before calling runSreRevision.
    jobType: 'revision',
    trackingId: 'track-123',
    fingerprint: 'fp-abc12345',
    repoSlug: 'MillionOnMars/lumina5',
    branchName: 'sre-fix/abc123',
    prNumber: 42,
    reviewBody: 'please revise',
    originalDiagnosis: {
      rootCause: 'race condition',
      proposedFix: 'add lock',
      confidence: 88,
      riskAssessment: 'low',
      affectedFiles: [{ filePath: 'a.ts', before: 'a', after: 'b', kind: 'replace' }],
    },
    source: 'GITHUB_ISSUE',
    issueNumber: 100,
    ...overrides,
  };
}

const mockContext = {} as never;
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

describe('sreRevision handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettingsValue.mockResolvedValue({ enabled: true });
    mockCountConsecutiveFailures.mockResolvedValue(0);
    mockCountFixesDispatchedToday.mockResolvedValue(0);
    mockFindByPrNumber.mockResolvedValue({ revisionCount: 1 });
    mockAtomicTransition.mockResolvedValue({ _id: 'track-123', revisionCount: 1 });
    mockHasCommentWithMarker.mockResolvedValue(false);
    mockAddIssueComment.mockResolvedValue(undefined);
    mockDeleteByKey.mockResolvedValue(undefined);
  });

  describe('wont_fix guard', () => {
    it('transitions to wont_fix and skips dispatch when re-diagnosis returns no affected files', async () => {
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'fix already applied',
          proposedFix: 'no changes needed',
          confidence: 95,
          riskAssessment: 'none',
          affectedFiles: [],
        },
      });

      await dispatch(makeSqsEvent(makeRevisionRequest()), mockContext, mockLogger);

      expect(mockAtomicTransition).toHaveBeenCalledWith(
        'track-123',
        'revision_requested',
        'wont_fix',
        expect.objectContaining({
          errorMessage: 'Revision determined no code fix is needed',
        })
      );
      expect(mockAtomicTransition).not.toHaveBeenCalledWith(
        'track-123',
        'revision_requested',
        'fixing',
        expect.anything()
      );
      expect(mockSendToQueue).not.toHaveBeenCalled();
      expect(mockPostSreNoFixNeededMessage).toHaveBeenCalled();
    });

    it('transitions to wont_fix when all affected files are no-ops (before === after)', async () => {
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'cosmetic',
          proposedFix: 'no-op',
          confidence: 90,
          riskAssessment: 'none',
          affectedFiles: [
            { filePath: 'a.ts', before: 'x', after: 'x', kind: 'replace' },
            { filePath: 'b.ts', before: 'y', after: 'y', kind: 'replace' },
          ],
        },
      });

      await dispatch(makeSqsEvent(makeRevisionRequest()), mockContext, mockLogger);

      expect(mockAtomicTransition).toHaveBeenCalledWith(
        'track-123',
        'revision_requested',
        'wont_fix',
        expect.any(Object)
      );
      expect(mockSendToQueue).not.toHaveBeenCalled();
    });

    it('posts a deduped GH issue comment when issueNumber is set', async () => {
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'already fixed',
          proposedFix: 'no changes needed',
          confidence: 95,
          riskAssessment: 'none',
          affectedFiles: [],
        },
      });

      await dispatch(makeSqsEvent(makeRevisionRequest({ issueNumber: 100 })), mockContext, mockLogger);

      expect(mockHasCommentWithMarker).toHaveBeenCalledWith('MillionOnMars/lumina5', 100, '<!-- sre-wont-fix -->');
      expect(mockAddIssueComment).toHaveBeenCalledWith(
        'MillionOnMars/lumina5',
        100,
        expect.stringContaining('No Fix Needed')
      );
    });

    it('includes Reason field with proposedFix in the GH comment', async () => {
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'long root cause description goes here',
          proposedFix: 'this is the rationale that should appear under Reason',
          confidence: 95,
          riskAssessment: 'none',
          affectedFiles: [],
        },
      });

      await dispatch(makeSqsEvent(makeRevisionRequest({ issueNumber: 100 })), mockContext, mockLogger);

      const commentBody = mockAddIssueComment.mock.calls[0]?.[2] as string;
      expect(commentBody).toContain('*Reason:* this is the rationale that should appear under Reason');
      expect(commentBody).toContain('*Root cause:* long root cause description goes here');
    });

    it('escapes Markdown and neutralizes @-mentions in the GH comment (security)', async () => {
      // LLM-generated content can contain Markdown specials and @-handles that
      // would otherwise inject formatting or ping real users/teams.
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'undefined `*foo*` at @StormyEmery [oops]',
          proposedFix: 'cc @MillionOnMars/platform — fix _here_',
          confidence: 95,
          riskAssessment: 'none',
          affectedFiles: [],
        },
      });

      await dispatch(makeSqsEvent(makeRevisionRequest({ issueNumber: 100 })), mockContext, mockLogger);

      const commentBody = mockAddIssueComment.mock.calls[0]?.[2] as string;
      // Markdown specials are escaped (backticks, asterisks, brackets, underscores)
      expect(commentBody).toContain('\\`\\*foo\\*\\`');
      expect(commentBody).toContain('\\[oops\\]');
      expect(commentBody).toContain('\\_here\\_');
      // @ mentions are broken by zero-width space (U+200B)
      expect(commentBody).toContain('@​StormyEmery');
      expect(commentBody).toContain('@​MillionOnMars/platform');
      // Raw forms should NOT appear
      expect(commentBody).not.toContain('@StormyEmery');
      expect(commentBody).not.toContain('@MillionOnMars/platform');
    });

    it('truncates rootCause and proposedFix at 500 chars', async () => {
      const longRoot = 'r'.repeat(800);
      const longFix = 'f'.repeat(800);
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: longRoot,
          proposedFix: longFix,
          confidence: 90,
          riskAssessment: 'none',
          affectedFiles: [],
        },
      });

      await dispatch(makeSqsEvent(makeRevisionRequest({ issueNumber: 100 })), mockContext, mockLogger);

      const commentBody = mockAddIssueComment.mock.calls[0]?.[2] as string;
      // 500-char slice plus the prefix "*Root cause:* " - no run of 501 r's
      expect(commentBody).toContain('r'.repeat(500));
      expect(commentBody).not.toContain('r'.repeat(501));
      expect(commentBody).toContain('f'.repeat(500));
      expect(commentBody).not.toContain('f'.repeat(501));
    });

    it('does not post a GH comment when the marker is already present', async () => {
      mockHasCommentWithMarker.mockResolvedValue(true);
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'already fixed',
          proposedFix: 'no changes needed',
          confidence: 95,
          riskAssessment: 'none',
          affectedFiles: [],
        },
      });

      await dispatch(makeSqsEvent(makeRevisionRequest({ issueNumber: 100 })), mockContext, mockLogger);

      expect(mockAddIssueComment).not.toHaveBeenCalled();
    });

    it('aborts cleanly when the wont_fix CAS loses a race (atomicTransition returns null)', async () => {
      // Simulate concurrent state change: the wont_fix atomicTransition returns null,
      // meaning the doc was no longer in `revision_requested` when we tried to claim it.
      mockAtomicTransition.mockResolvedValueOnce(null);
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'already fixed',
          proposedFix: 'no changes needed',
          confidence: 95,
          riskAssessment: 'none',
          affectedFiles: [],
        },
      });

      await dispatch(makeSqsEvent(makeRevisionRequest()), mockContext, mockLogger);

      // CAS attempted; no follow-up side effects since we lost the race
      expect(mockAtomicTransition).toHaveBeenCalledWith(
        'track-123',
        'revision_requested',
        'wont_fix',
        expect.any(Object)
      );
      expect(mockPostSreNoFixNeededMessage).not.toHaveBeenCalled();
      expect(mockHasCommentWithMarker).not.toHaveBeenCalled();
      expect(mockAddIssueComment).not.toHaveBeenCalled();
      expect(mockSendToQueue).not.toHaveBeenCalled();
      // Dedup is cleared so a future revision attempt isn't blocked
      expect(mockDeleteByKey).toHaveBeenCalled();
    });

    it('skips GH comment when issueNumber is undefined (CloudWatch-source revision)', async () => {
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'cloudwatch noop',
          proposedFix: 'no changes needed',
          confidence: 95,
          riskAssessment: 'none',
          affectedFiles: [],
        },
      });

      await dispatch(makeSqsEvent(makeRevisionRequest({ issueNumber: undefined })), mockContext, mockLogger);

      // Slack still posts (it's the primary notification), but no GH comment path runs
      expect(mockPostSreNoFixNeededMessage).toHaveBeenCalled();
      expect(mockHasCommentWithMarker).not.toHaveBeenCalled();
      expect(mockAddIssueComment).not.toHaveBeenCalled();
      // Still transitioned to wont_fix
      expect(mockAtomicTransition).toHaveBeenCalledWith(
        'track-123',
        'revision_requested',
        'wont_fix',
        expect.any(Object)
      );
    });

    it('still dispatches to fix queue when affected files have real changes', async () => {
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'real bug',
          proposedFix: 'real fix',
          confidence: 90,
          riskAssessment: 'low',
          affectedFiles: [{ filePath: 'a.ts', before: 'old', after: 'new', kind: 'replace' }],
        },
      });

      await dispatch(makeSqsEvent(makeRevisionRequest()), mockContext, mockLogger);

      expect(mockAtomicTransition).toHaveBeenCalledWith(
        'track-123',
        'revision_requested',
        'fixing',
        expect.any(Object)
      );
      expect(mockSendToQueue).toHaveBeenCalled();
      expect(mockPostSreNoFixNeededMessage).not.toHaveBeenCalled();
    });
  });

  describe('CI self-heal — blockTestEdits propagation & escalation (Rule 2)', () => {
    it('sets blockTestEdits=true on the fix request when ciFailureOutput is present', async () => {
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'real bug',
          proposedFix: 'real fix',
          confidence: 90,
          riskAssessment: 'low',
          affectedFiles: [{ filePath: 'a.ts', before: 'old', after: 'new', kind: 'replace' }],
        },
      });

      await dispatch(
        makeSqsEvent(makeRevisionRequest({ ciFailureOutput: 'FAIL a.test.ts > expected 2 got 1' })),
        mockContext,
        mockLogger
      );

      expect(mockSendToQueue).toHaveBeenCalled();
      const fixRequest = mockSendToQueue.mock.calls[0][1] as Record<string, unknown>;
      expect(fixRequest.blockTestEdits).toBe(true);
    });

    it('leaves blockTestEdits falsy on a human-review revision (no ciFailureOutput)', async () => {
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'real bug',
          proposedFix: 'real fix',
          confidence: 90,
          riskAssessment: 'low',
          affectedFiles: [{ filePath: 'a.ts', before: 'old', after: 'new', kind: 'replace' }],
        },
      });

      await dispatch(makeSqsEvent(makeRevisionRequest()), mockContext, mockLogger);

      const fixRequest = mockSendToQueue.mock.calls[0][1] as Record<string, unknown>;
      expect(fixRequest.blockTestEdits).toBeFalsy();
    });

    it('escalates with a PR comment when a CI self-heal revision fails (diagnosis null)', async () => {
      mockRevise.mockResolvedValue({ diagnosis: null, failureReason: 'could not produce in-scope fix' });

      await dispatch(makeSqsEvent(makeRevisionRequest({ ciFailureOutput: 'FAIL a.test.ts' })), mockContext, mockLogger);

      expect(mockAtomicTransition).toHaveBeenCalledWith(
        'track-123',
        'revision_requested',
        'failed',
        expect.any(Object)
      );
      expect(mockHasCommentWithMarker).toHaveBeenCalledWith(
        'MillionOnMars/lumina5',
        42,
        '<!-- sre-selfheal-escalation -->'
      );
      expect(mockAddIssueComment).toHaveBeenCalledWith(
        'MillionOnMars/lumina5',
        42,
        expect.stringContaining('Self-Heal Escalation')
      );
      expect(mockSendToQueue).not.toHaveBeenCalled();
    });

    it('does NOT post an escalation comment on a human-review revision failure (no ciFailureOutput)', async () => {
      mockRevise.mockResolvedValue({ diagnosis: null, failureReason: 'identical fix' });

      await dispatch(makeSqsEvent(makeRevisionRequest()), mockContext, mockLogger);

      expect(mockAddIssueComment).not.toHaveBeenCalled();
    });

    it('routes an explicit escalate:true diagnosis to failed + escalation comment', async () => {
      mockRevise.mockResolvedValue({
        diagnosis: {
          rootCause: 'the failing test encodes intended behavior the fix contradicts',
          proposedFix: 'human must decide',
          confidence: 0,
          riskAssessment: 'n/a',
          affectedFiles: [],
          escalate: true,
        },
      });

      await dispatch(
        makeSqsEvent(makeRevisionRequest({ ciFailureOutput: 'FAIL guard.test.ts' })),
        mockContext,
        mockLogger
      );

      expect(mockAtomicTransition).toHaveBeenCalledWith(
        'track-123',
        'revision_requested',
        'failed',
        expect.objectContaining({ errorMessage: expect.stringContaining('Escalated to human') })
      );
      expect(mockAddIssueComment).toHaveBeenCalledWith(
        'MillionOnMars/lumina5',
        42,
        expect.stringContaining('Self-Heal Escalation')
      );
      expect(mockSendToQueue).not.toHaveBeenCalled();
      expect(mockPostSreNoFixNeededMessage).not.toHaveBeenCalled();
    });
  });
});
