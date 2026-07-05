import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Mock dependencies
const mockAtomicTransition = vi.fn();
const mockUpsertFromFix = vi.fn();
const mockGetSettingsValue = vi.fn();
const mockResolveFullConfig = vi.fn().mockReturnValue({ slack: { approverIds: '' } });
const mockPostSreFixSuccessMessage = vi.fn();
const mockPostSreFixFailureMessage = vi.fn();
const mockPostSreAlreadyFixedMessage = vi.fn();
const mockHasCommentWithMarker = vi.fn();
const mockAddIssueComment = vi.fn();
const mockClaimCiRetry = vi.fn();
const mockFindFullById = vi.fn();
const mockSendToQueue = vi.fn();
const mockGetSourceQueueUrl = vi.fn(() => 'https://sqs.us-east-2.amazonaws.com/123/sreJobQueue');
const mockPostSreCiRetryMessage = vi.fn();

vi.mock('@server/utils/sqs', () => ({
  sendToQueue: (...args: unknown[]) => mockSendToQueue(...args),
}));

vi.mock('@server/utils/dlqRegistry', () => ({
  getSourceQueueUrl: (...args: unknown[]) => mockGetSourceQueueUrl(...args),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  sreErrorTrackingRepository: {
    atomicTransition: (...args: unknown[]) => mockAtomicTransition(...args),
    findById: vi.fn(),
    claimCiRetry: (...args: unknown[]) => mockClaimCiRetry(...args),
    findFullById: (...args: unknown[]) => mockFindFullById(...args),
  },
  sreErrorPatternRepository: {
    upsertFromFix: (...args: unknown[]) => mockUpsertFromFix(...args),
  },
  adminSettingsRepository: {
    getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
  },
}));

vi.mock('@server/utils/config', () => ({
  Config: {
    MONGODB_URI: 'mongodb://localhost:27017/%STAGE%',
    STAGE: 'dev',
    SECRET_ENCRYPTION_KEY: 'test-encryption-key',
  },
}));

vi.mock('@bike4mind/common', () => ({
  SreAgentConfigSchema: {
    parse: vi.fn((v: unknown) => v ?? { repos: [] }),
  },
  SRE_DEFAULT_REPO_SLUG: 'MillionOnMars/lumina5',
  resolveCallbackToken: vi.fn((config: unknown, _repoSlug: unknown) => {
    const cfg = config as { repos?: Array<{ callbackToken?: string }> };
    return cfg?.repos?.[0]?.callbackToken ?? '';
  }),
  resolveFullConfig: (...args: unknown[]) => mockResolveFullConfig(...args),
}));

const mockDecryptSecret = vi.fn();
vi.mock('@server/security/secretEncryption', () => ({
  decryptSecret: (...args: unknown[]) => mockDecryptSecret(...args),
}));

vi.mock('@server/integrations/slack/sreSlackApproval', () => ({
  postSreFixSuccessMessage: (...args: unknown[]) => mockPostSreFixSuccessMessage(...args),
  postSreFixFailureMessage: (...args: unknown[]) => mockPostSreFixFailureMessage(...args),
  postSreAlreadyFixedMessage: (...args: unknown[]) => mockPostSreAlreadyFixedMessage(...args),
  postSreCiRetryMessage: (...args: unknown[]) => mockPostSreCiRetryMessage(...args),
}));

vi.mock('@server/services/githubService', () => ({
  GitHubService: {
    forSystem: vi.fn(async () => ({
      hasCommentWithMarker: (...args: unknown[]) => mockHasCommentWithMarker(...args),
      addIssueComment: (...args: unknown[]) => mockAddIssueComment(...args),
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
    Logger: vi.fn(function () {
      return mockLogger;
    }),
  };
});

// Import after mocks
import handler from '../../../pages/api/sre/workflow-callback';

function createMockReqRes(body: Record<string, unknown>, token = 'valid-token') {
  const req = {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body,
  } as unknown as NextApiRequest;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;

  return { req, res };
}

describe('workflow-callback handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: config has encrypted callback token in the repo entry
    mockGetSettingsValue.mockResolvedValue({
      repos: [
        { owner: 'MillionOnMars', repo: 'lumina5', callbackToken: 'encrypted-token', slack: { approverIds: '' } },
      ],
    });
    mockDecryptSecret.mockReturnValue('valid-token');
    mockResolveFullConfig.mockReturnValue({ slack: { approverIds: '' } });
  });

  describe('auth', () => {
    it('should return 401 when callbackToken is not configured', async () => {
      mockGetSettingsValue.mockResolvedValue({
        repos: [{ owner: 'MillionOnMars', repo: 'lumina5', callbackToken: '', slack: { approverIds: '' } }],
      });

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'success',
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    });

    it('should return 401 when token does not match', async () => {
      const { req, res } = createMockReqRes(
        {
          fingerprint: 'fp-123',
          trackingId: 'track-1',
          status: 'success',
        },
        'wrong-token'
      );

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    });
  });

  describe('success callback', () => {
    it('should transition fixing → fixed and return ok', async () => {
      const transitionedDoc = {
        id: 'track-1',
        diagnosisResult: {
          confidence: 80,
          rootCause: 'test',
          affectedFiles: [{ filePath: 'file.ts' }],
        },
        errorMessage: 'TypeError: test',
      };
      mockAtomicTransition.mockResolvedValue(transitionedDoc);
      mockUpsertFromFix.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'success',
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
        workflowRunUrl: 'https://github.com/MillionOnMars/lumina5/actions/runs/1',
      });

      await handler(req, res);

      expect(mockAtomicTransition).toHaveBeenCalledWith('track-1', 'fixing', 'fixed', {
        fixPrNumber: 42,
        workflowRunUrl: 'https://github.com/MillionOnMars/lumina5/actions/runs/1',
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    it('should return duplicate:true on duplicate success callback', async () => {
      mockAtomicTransition.mockResolvedValue(null);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'success',
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, duplicate: true });
      expect(mockUpsertFromFix).not.toHaveBeenCalled();
    });

    it('should use transitioned doc directly for pattern library (no findById)', async () => {
      const transitionedDoc = {
        id: 'track-1',
        repoSlug: 'MillionOnMars/lumina5',
        diagnosisResult: {
          confidence: 90,
          rootCause: 'null ref',
          affectedFiles: [{ filePath: 'api.ts' }],
        },
        errorMessage: 'NullPointerError: test',
      };
      mockAtomicTransition.mockResolvedValue(transitionedDoc);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'success',
        prNumber: 10,
        prUrl: 'https://github.com/org/repo/pull/10',
      });

      await handler(req, res);

      expect(mockUpsertFromFix).toHaveBeenCalledWith(
        'fp-123',
        'MillionOnMars/lumina5',
        expect.objectContaining({
          name: expect.stringContaining('NullPointerError'),
          originTrackingId: 'track-1',
          originPrNumber: 10,
        })
      );
    });

    it('should return 400 and not call atomicTransition when prUrl is missing on success', async () => {
      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'success',
        prNumber: 42,
        // prUrl intentionally omitted
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'prNumber and prUrl are required for success callbacks' });
      expect(mockAtomicTransition).not.toHaveBeenCalled();
    });
  });

  describe('failure callback', () => {
    it('should transition fixing → failed', async () => {
      mockAtomicTransition.mockResolvedValue({ id: 'track-1' });

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
        failureReason: 'Build failed',
      });

      await handler(req, res);

      expect(mockAtomicTransition).toHaveBeenCalledWith('track-1', 'fixing', 'failed', {
        workflowRunUrl: undefined,
        errorMessage: 'Build failed',
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    it('should return duplicate:true on duplicate failure callback', async () => {
      mockAtomicTransition.mockResolvedValue(null);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, duplicate: true });
    });
  });

  describe('recoverable CI failure → sreJobQueue', () => {
    it('dispatches a revision job to sreJobQueue tagged jobType: revision', async () => {
      mockResolveFullConfig.mockReturnValue({ slack: {}, defaultBranch: 'main', maxCiRetries: 3 });
      mockClaimCiRetry.mockResolvedValue({
        id: 'track-1',
        ciRetryCount: 1,
        fixPrNumber: 0,
        source: 'GITHUB_ISSUE',
        githubIssueNumber: 100,
        diagnosisResult: { confidence: 80, rootCause: 'rc', proposedFix: 'pf', affectedFiles: [] },
      });

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
        recoverable: true,
        failureReason: 'typecheck failed',
        failureOutput: 'TS2304: cannot find name',
        workflowRunUrl: 'https://github.com/MillionOnMars/lumina5/actions/runs/9',
      });

      await handler(req, res);

      expect(mockGetSourceQueueUrl).toHaveBeenCalledWith('sreJobQueue');
      expect(mockSendToQueue).toHaveBeenCalledTimes(1);
      const [url, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toContain('sreJobQueue');
      expect(payload.jobType).toBe('revision');
      expect(payload.trackingId).toBe('track-1');
      expect(payload.ciFailureOutput).toBe('TS2304: cannot find name');
      expect(res.json).toHaveBeenCalledWith({ ok: true, retrying: true });
    });

    it('does not dispatch when the CI retry cap is exhausted', async () => {
      mockResolveFullConfig.mockReturnValue({ slack: {}, defaultBranch: 'main', maxCiRetries: 3 });
      mockClaimCiRetry.mockResolvedValue(null); // claim failed
      mockFindFullById.mockResolvedValue({ status: 'fixing', errorMessage: 'boom' }); // still fixing -> cap exhausted

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
        recoverable: true,
        failureReason: 'typecheck failed',
      });

      await handler(req, res);

      expect(mockSendToQueue).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ ok: true, capExhausted: true });
    });
  });

  describe('recoverable CI failure — cap exhausted escalation', () => {
    beforeEach(() => {
      mockResolveFullConfig.mockReturnValue({ slack: { approverIds: '' }, maxCiRetries: 2 });
    });

    it('posts a deduped GH escalation comment when the CI retry cap is reached', async () => {
      // claimCiRetry returns null (cap reached) and the doc is still 'fixing' -> cap-exhausted path.
      mockClaimCiRetry.mockResolvedValue(null);
      mockFindFullById.mockResolvedValue({
        status: 'fixing',
        errorMessage: 'tests failing',
        githubIssueNumber: 777,
      });
      mockAtomicTransition.mockResolvedValue({ id: 'track-1' });
      mockHasCommentWithMarker.mockResolvedValue(false);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
        recoverable: true,
        failureReason: "Step 'tests' failed",
        failureOutput: 'FAIL src/foo.test.ts > regression guard',
      });

      await handler(req, res);

      expect(mockAtomicTransition).toHaveBeenCalledWith(
        'track-1',
        'fixing',
        'failed',
        expect.objectContaining({ errorMessage: expect.stringContaining('CI retry cap reached') })
      );
      expect(mockHasCommentWithMarker).toHaveBeenCalledWith(
        'MillionOnMars/lumina5',
        777,
        '<!-- sre-ci-retry-exhausted -->'
      );
      expect(mockAddIssueComment).toHaveBeenCalledWith(
        'MillionOnMars/lumina5',
        777,
        expect.stringContaining('Self-Heal Exhausted')
      );
      // The failing output is surfaced for the human
      expect(mockAddIssueComment.mock.calls[0][2]).toContain('regression guard');
      expect(res.json).toHaveBeenCalledWith({ ok: true, capExhausted: true });
    });

    it('prefers the fix PR over the source issue when a fixPrNumber exists', async () => {
      // A revision-triggered cap exhaustion has both a fixPrNumber (the PR a reviewer is looking at)
      // and a githubIssueNumber. The escalation comment should land on the PR, not the issue.
      mockClaimCiRetry.mockResolvedValue(null);
      mockFindFullById.mockResolvedValue({
        status: 'fixing',
        errorMessage: 'tests failing',
        githubIssueNumber: 777,
        fixPrNumber: 555,
      });
      mockAtomicTransition.mockResolvedValue({ id: 'track-1' });
      mockHasCommentWithMarker.mockResolvedValue(false);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
        recoverable: true,
        failureReason: "Step 'tests' failed",
      });

      await handler(req, res);

      expect(mockAddIssueComment).toHaveBeenCalledWith(
        'MillionOnMars/lumina5',
        555,
        expect.stringContaining('Self-Heal Exhausted')
      );
      expect(mockAddIssueComment).not.toHaveBeenCalledWith('MillionOnMars/lumina5', 777, expect.anything());
    });

    it('skips the GH comment when there is no source issue (CloudWatch-only)', async () => {
      mockClaimCiRetry.mockResolvedValue(null);
      mockFindFullById.mockResolvedValue({ status: 'fixing', errorMessage: 'tests failing' }); // no githubIssueNumber
      mockAtomicTransition.mockResolvedValue({ id: 'track-1' });

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
        recoverable: true,
        failureReason: "Step 'tests' failed",
      });

      await handler(req, res);

      expect(mockAddIssueComment).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ ok: true, capExhausted: true });
    });
  });

  describe('slack notifications', () => {
    it('should call postSreFixSuccessMessage after success transition', async () => {
      const transitionedDoc = {
        id: 'track-1',
        diagnosisResult: { confidence: 85, rootCause: 'test', affectedFiles: [{ filePath: 'f.ts' }] },
        errorMessage: 'TypeError: test',
      };
      mockAtomicTransition.mockResolvedValue(transitionedDoc);
      mockUpsertFromFix.mockResolvedValue(undefined);
      mockPostSreFixSuccessMessage.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'success',
        prNumber: 42,
        prUrl: 'https://github.com/pr/42',
        workflowRunUrl: 'https://github.com/MillionOnMars/lumina5/actions/runs/1',
      });

      await handler(req, res);

      expect(mockPostSreFixSuccessMessage).toHaveBeenCalledWith(
        'track-1',
        'fp-123',
        'TypeError: test',
        42,
        'https://github.com/pr/42',
        'https://github.com/MillionOnMars/lumina5/actions/runs/1',
        expect.any(Object)
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should call postSreFixFailureMessage after failure transition', async () => {
      mockAtomicTransition.mockResolvedValue({ id: 'track-1', errorMessage: 'Build failed' });
      mockPostSreFixFailureMessage.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
        failureReason: 'Build failed',
        workflowRunUrl: 'https://github.com/MillionOnMars/lumina5/actions/runs/2',
      });

      await handler(req, res);

      expect(mockPostSreFixFailureMessage).toHaveBeenCalledWith(
        'track-1',
        'fp-123',
        'Build failed',
        'Build failed',
        'https://github.com/MillionOnMars/lumina5/actions/runs/2',
        expect.any(Object)
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should still return 200 when Slack notification fails', async () => {
      const transitionedDoc = {
        id: 'track-1',
        diagnosisResult: { confidence: 85, rootCause: 'test', affectedFiles: [{ filePath: 'f.ts' }] },
        errorMessage: 'TypeError: test',
      };
      mockAtomicTransition.mockResolvedValue(transitionedDoc);
      mockUpsertFromFix.mockResolvedValue(undefined);
      mockPostSreFixSuccessMessage.mockRejectedValue(new Error('Slack down'));

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'success',
        prNumber: 42,
        prUrl: 'https://github.com/pr/42',
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    it('should NOT call Slack on duplicate callbacks', async () => {
      mockAtomicTransition.mockResolvedValue(null);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'success',
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
      });

      await handler(req, res);

      expect(mockPostSreFixSuccessMessage).not.toHaveBeenCalled();
      expect(mockPostSreFixFailureMessage).not.toHaveBeenCalled();
    });
  });

  describe('already_fixed callback', () => {
    it('should transition fixing → already_fixed and return ok', async () => {
      mockAtomicTransition.mockResolvedValue({ id: 'track-1', errorMessage: 'TypeError: bad' });

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'already_fixed',
        workflowRunUrl: 'https://github.com/MillionOnMars/lumina5/actions/runs/1',
      });

      await handler(req, res);

      expect(mockAtomicTransition).toHaveBeenCalledWith('track-1', 'fixing', 'already_fixed', {
        workflowRunUrl: 'https://github.com/MillionOnMars/lumina5/actions/runs/1',
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    it('should return duplicate:true on duplicate already_fixed callback', async () => {
      mockAtomicTransition.mockResolvedValue(null);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'already_fixed',
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, duplicate: true });
      expect(mockPostSreAlreadyFixedMessage).not.toHaveBeenCalled();
    });

    it('should call postSreAlreadyFixedMessage with correct args', async () => {
      mockAtomicTransition.mockResolvedValue({
        id: 'track-1',
        errorMessage: 'TypeError: bad',
        githubIssueNumber: 42,
      });
      mockPostSreAlreadyFixedMessage.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'already_fixed',
        workflowRunUrl: 'https://github.com/MillionOnMars/lumina5/actions/runs/1',
      });

      await handler(req, res);

      expect(mockPostSreAlreadyFixedMessage).toHaveBeenCalledWith(
        'track-1',
        'TypeError: bad',
        'fp-123',
        42,
        'MillionOnMars/lumina5',
        'https://github.com/MillionOnMars/lumina5/actions/runs/1',
        expect.any(Object)
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should still return 200 when postSreAlreadyFixedMessage throws', async () => {
      mockAtomicTransition.mockResolvedValue({ id: 'track-1', errorMessage: 'TypeError: bad' });
      mockPostSreAlreadyFixedMessage.mockRejectedValue(new Error('Slack down'));

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'already_fixed',
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    it('should post GH comment when githubIssueNumber is set and marker is absent', async () => {
      mockAtomicTransition.mockResolvedValue({
        id: 'track-1',
        errorMessage: 'TypeError: bad',
        githubIssueNumber: 42,
      });
      mockHasCommentWithMarker.mockResolvedValue(false);
      mockAddIssueComment.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'already_fixed',
        workflowRunUrl: 'https://github.com/MillionOnMars/lumina5/actions/runs/1',
      });

      await handler(req, res);

      expect(mockAddIssueComment).toHaveBeenCalledWith(
        'MillionOnMars/lumina5',
        42,
        expect.stringContaining('<!-- sre-already-fixed -->')
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should skip GH comment when marker already present', async () => {
      mockAtomicTransition.mockResolvedValue({
        id: 'track-1',
        errorMessage: 'TypeError: bad',
        githubIssueNumber: 42,
      });
      mockHasCommentWithMarker.mockResolvedValue(true);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'already_fixed',
      });

      await handler(req, res);

      expect(mockAddIssueComment).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should skip GH comment entirely when githubIssueNumber is absent', async () => {
      mockAtomicTransition.mockResolvedValue({ id: 'track-1', errorMessage: 'TypeError: bad' });

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'already_fixed',
      });

      await handler(req, res);

      expect(mockHasCommentWithMarker).not.toHaveBeenCalled();
      expect(mockAddIssueComment).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('GH comment falls back to "N/A" when workflowRunUrl is absent', async () => {
      mockAtomicTransition.mockResolvedValue({
        id: 'track-1',
        errorMessage: 'TypeError: bad',
        githubIssueNumber: 42,
      });
      mockHasCommentWithMarker.mockResolvedValue(false);
      mockAddIssueComment.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'already_fixed',
        // workflowRunUrl intentionally omitted
      });

      await handler(req, res);

      expect(mockAddIssueComment).toHaveBeenCalledWith(
        'MillionOnMars/lumina5',
        42,
        expect.stringContaining('Workflow run: N/A')
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('failure callback — undefined fallbacks', () => {
    it('uses "Workflow failed" when failureReason is absent', async () => {
      mockAtomicTransition.mockResolvedValue({ id: 'track-1', errorMessage: 'TypeError: bad' });

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
        // failureReason intentionally omitted
      });

      await handler(req, res);

      expect(mockAtomicTransition).toHaveBeenCalledWith('track-1', 'fixing', 'failed', {
        workflowRunUrl: undefined,
        errorMessage: 'Workflow failed',
      });
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('uses "Unknown" as Slack failureReason when absent', async () => {
      mockAtomicTransition.mockResolvedValue({ id: 'track-1', errorMessage: 'TypeError: bad' });
      mockPostSreFixFailureMessage.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
        // failureReason intentionally omitted
      });

      await handler(req, res);

      expect(mockPostSreFixFailureMessage).toHaveBeenCalledWith(
        'track-1',
        'fp-123',
        'TypeError: bad',
        'Unknown',
        '',
        expect.any(Object)
      );
    });
  });

  describe('validation', () => {
    it('returns 500 when workflowRunUrl fails the GitHub Actions regex refinement', async () => {
      // Zod .refine() throws ZodError -> caught by try/catch -> 500
      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'success',
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
        workflowRunUrl: 'https://github.com/org/repo/NOT-ACTIONS/runs/1', // fails regex
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
      expect(mockAtomicTransition).not.toHaveBeenCalled();
    });

    it('returns 500 when repoSlug fails regex validation (spaces or path traversal)', async () => {
      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
        repoSlug: 'org/repo/extra', // extra path segment - fails regex
        failureReason: 'Build failed',
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
      expect(mockAtomicTransition).not.toHaveBeenCalled();
    });

    it('returns 404 when resolveFullConfig returns null (repo not configured)', async () => {
      mockResolveFullConfig.mockReturnValueOnce(null);

      const { req, res } = createMockReqRes({
        fingerprint: 'fp-123',
        trackingId: 'track-1',
        status: 'failure',
        failureReason: 'Build failed',
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Repo not configured' });
      expect(mockAtomicTransition).not.toHaveBeenCalled();
    });
  });
});
