import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockFindByPrNumber,
  mockClaimRevision,
  mockUpdateStatus,
  mockGetSettingsValue,
  mockSendToQueue,
  mockIncrementCounterConditional,
  mockPostEscalation,
  mockResolveFullConfig,
} = vi.hoisted(() => ({
  mockFindByPrNumber: vi.fn(),
  mockClaimRevision: vi.fn(),
  mockUpdateStatus: vi.fn(),
  mockGetSettingsValue: vi.fn(),
  mockSendToQueue: vi.fn(),
  mockIncrementCounterConditional: vi.fn(),
  mockPostEscalation: vi.fn(),
  mockResolveFullConfig: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
  },
  sreErrorTrackingRepository: {
    findByPrNumber: (...args: unknown[]) => mockFindByPrNumber(...args),
    claimRevision: (...args: unknown[]) => mockClaimRevision(...args),
    updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
  },
  cacheRepository: {
    incrementCounterConditional: (...args: unknown[]) => mockIncrementCounterConditional(...args),
  },
}));

vi.mock('@server/utils/sqs', () => ({
  sendToQueue: (...args: unknown[]) => mockSendToQueue(...args),
}));

vi.mock('@server/utils/dlqRegistry', () => ({
  getSourceQueueUrl: vi.fn().mockReturnValue('https://sqs.us-east-2.amazonaws.com/123/sreJobQueue'),
}));

vi.mock('@server/integrations/slack/sreSlackApproval', () => ({
  postSreRevisionEscalationMessage: (...args: unknown[]) => mockPostEscalation(...args),
}));

vi.mock('@bike4mind/common', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@bike4mind/common');
  return {
    ...actual,
    SreAgentConfigSchema: {
      parse: vi.fn((v: unknown) => ({
        repos: [],
        ...(v as Record<string, unknown>),
      })),
    },
    resolveFullConfig: mockResolveFullConfig,
  };
});

import { dispatchReviewToSreRevision } from './sreRevisionDispatch';

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'submitted',
    review: {
      state: 'changes_requested',
      body: 'Please fix the null check',
      user: { login: 'reviewer-user' },
    },
    pull_request: {
      number: 42,
      head: { ref: 'sre-fix/abc123-xyz' },
      html_url: 'https://github.com/owner/repo/pull/42',
      user: { login: 'sre-agent[bot]' },
    },
    repository: { full_name: 'owner/repo' },
    ...overrides,
  };
}

function makeTrackingDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'track-1',
    errorFingerprint: 'fp-abc123',
    source: 'GITHUB_ISSUE',
    status: 'fixed',
    revisionCount: 0,
    diagnosisResult: {
      rootCause: 'Null pointer',
      proposedFix: 'Add null check',
      confidence: 85,
      riskAssessment: 'low',
      affectedFiles: [{ filePath: 'test.ts', before: 'a', after: 'b' }],
    },
    githubIssueNumber: 100,
    ...overrides,
  };
}

describe('dispatchReviewToSreRevision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettingsValue.mockResolvedValue({ repos: [] });
    mockResolveFullConfig.mockReturnValue({ enabled: true, maxRevisions: 2, slack: {} });
    mockIncrementCounterConditional.mockResolvedValue({ success: true, count: 1 });
  });

  it('dispatches revision for sre-fix/* branch with changes_requested', async () => {
    const tracking = makeTrackingDoc();
    mockFindByPrNumber.mockResolvedValue(tracking);
    mockClaimRevision.mockResolvedValue({ ...tracking, revisionCount: 1 });

    const result = await dispatchReviewToSreRevision(makePayload());

    expect(result.dispatched).toBe(true);
    expect(mockFindByPrNumber).toHaveBeenCalledWith(42, 'owner/repo');
    expect(mockClaimRevision).toHaveBeenCalledWith('track-1', 2);
    expect(mockSendToQueue).toHaveBeenCalledWith(
      'https://sqs.us-east-2.amazonaws.com/123/sreJobQueue',
      expect.objectContaining({
        jobType: 'revision',
        trackingId: 'track-1',
        fingerprint: 'fp-abc123',
        branchName: 'sre-fix/abc123-xyz',
        prNumber: 42,
        reviewBody: 'Please fix the null check',
      })
    );
  });

  it('rejects non-sre-fix branches', async () => {
    const payload = makePayload({
      pull_request: {
        number: 42,
        head: { ref: 'feat/some-feature' },
        html_url: 'https://github.com/owner/repo/pull/42',
        user: { login: 'someone' },
      },
    });
    const result = await dispatchReviewToSreRevision(payload);
    expect(result).toEqual({ dispatched: false, reason: 'not-sre-branch' });
    expect(mockFindByPrNumber).not.toHaveBeenCalled();
  });

  it('rejects non-submitted actions', async () => {
    const result = await dispatchReviewToSreRevision(makePayload({ action: 'edited' }));
    expect(result).toEqual({ dispatched: false, reason: 'payload-mismatch' });
  });

  it('rejects non-changes_requested states', async () => {
    const payload = makePayload({
      review: { state: 'approved', body: null, user: { login: 'user' } },
    });
    const result = await dispatchReviewToSreRevision(payload);
    expect(result).toEqual({ dispatched: false, reason: 'payload-mismatch' });
  });

  it('rejects invalid branch names (injection prevention)', async () => {
    const payload = makePayload({
      pull_request: {
        number: 42,
        head: { ref: 'sre-fix/$(rm -rf /)' },
        html_url: 'https://github.com/owner/repo/pull/42',
        user: { login: 'someone' },
      },
    });
    const result = await dispatchReviewToSreRevision(payload);
    expect(result).toEqual({ dispatched: false, reason: 'invalid-branch-name' });
    expect(mockFindByPrNumber).not.toHaveBeenCalled();
  });

  it('skips when SRE agent is disabled for repo', async () => {
    mockResolveFullConfig.mockReturnValue({ enabled: false, maxRevisions: 2, slack: {} });
    const result = await dispatchReviewToSreRevision(makePayload());
    expect(result).toEqual({ dispatched: false, reason: 'repo-disabled' });
    expect(mockClaimRevision).not.toHaveBeenCalled();
  });

  it('skips when repo is not configured (resolveFullConfig returns null)', async () => {
    mockResolveFullConfig.mockReturnValue(null);
    const result = await dispatchReviewToSreRevision(makePayload());
    expect(result).toEqual({ dispatched: false, reason: 'repo-not-configured' });
    expect(mockClaimRevision).not.toHaveBeenCalled();
  });

  it('skips when maxRevisions is 0', async () => {
    mockResolveFullConfig.mockReturnValue({ enabled: true, maxRevisions: 0, slack: {} });
    const result = await dispatchReviewToSreRevision(makePayload());
    expect(result).toEqual({ dispatched: false, reason: 'revisions-disabled' });
  });

  it('dedup prevents double dispatch for same PR', async () => {
    mockIncrementCounterConditional.mockResolvedValue({ success: false, count: 2 });
    const result = await dispatchReviewToSreRevision(makePayload());
    expect(result).toEqual({ dispatched: false, reason: 'already-dispatched' });
    expect(mockFindByPrNumber).not.toHaveBeenCalled();
  });

  it('skips when no tracking document found', async () => {
    mockFindByPrNumber.mockResolvedValue(null);
    const result = await dispatchReviewToSreRevision(makePayload());
    expect(result).toEqual({ dispatched: false, reason: 'no-tracking-doc' });
    expect(mockClaimRevision).not.toHaveBeenCalled();
  });

  it('skips when tracking has no diagnosisResult', async () => {
    mockFindByPrNumber.mockResolvedValue(makeTrackingDoc({ diagnosisResult: undefined }));
    const result = await dispatchReviewToSreRevision(makePayload());
    expect(result).toEqual({ dispatched: false, reason: 'no-diagnosis' });
  });

  it('escalates when revision cap is reached', async () => {
    mockFindByPrNumber.mockResolvedValue(makeTrackingDoc());
    mockClaimRevision.mockResolvedValue(null);
    mockFindByPrNumber
      .mockResolvedValueOnce(makeTrackingDoc())
      .mockResolvedValueOnce(makeTrackingDoc({ revisionCount: 2 }));

    const result = await dispatchReviewToSreRevision(makePayload());

    expect(result).toEqual({ dispatched: false, reason: 'max-revisions-reached' });
    expect(mockPostEscalation).toHaveBeenCalledWith(
      'track-1',
      'fp-abc123',
      'https://github.com/owner/repo/pull/42',
      2,
      'Please fix the null check',
      expect.any(Object)
    );
    expect(mockSendToQueue).not.toHaveBeenCalled();
  });

  it('skips when claim fails for non-cap reasons', async () => {
    mockFindByPrNumber.mockResolvedValue(makeTrackingDoc({ status: 'revision_requested', revisionCount: 0 }));
    mockClaimRevision.mockResolvedValue(null);

    const result = await dispatchReviewToSreRevision(makePayload());

    expect(result).toEqual({ dispatched: false, reason: 'claim-failed' });
    expect(mockPostEscalation).not.toHaveBeenCalled();
    expect(mockSendToQueue).not.toHaveBeenCalled();
  });

  it('stores reviewer feedback on tracking doc', async () => {
    const tracking = makeTrackingDoc();
    mockFindByPrNumber.mockResolvedValue(tracking);
    mockClaimRevision.mockResolvedValue({ ...tracking, revisionCount: 1 });

    await dispatchReviewToSreRevision(
      makePayload({
        review: {
          state: 'changes_requested',
          body: 'Fix the edge case',
          user: { login: 'reviewer' },
        },
      })
    );

    expect(mockUpdateStatus).toHaveBeenCalledWith('track-1', 'revision_requested', {
      reviewerFeedback: 'Fix the edge case',
    });
  });
});
