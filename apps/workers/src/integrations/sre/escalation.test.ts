import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SreSourceType } from '@bike4mind/common';

const {
  mockFindActiveByFingerprint,
  mockUpdatePattern,
  mockGitHubForSystem,
  mockAddIssueComment,
  mockHasCommentWithMarker,
  mockPostRecurrenceMessage,
} = vi.hoisted(() => ({
  mockFindActiveByFingerprint: vi.fn(),
  mockUpdatePattern: vi.fn(),
  mockGitHubForSystem: vi.fn(),
  mockAddIssueComment: vi.fn(),
  mockHasCommentWithMarker: vi.fn(),
  mockPostRecurrenceMessage: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  sreErrorPatternRepository: {
    findActiveByFingerprint: (...args: unknown[]) => mockFindActiveByFingerprint(...args),
    update: (...args: unknown[]) => mockUpdatePattern(...args),
  },
}));

vi.mock('@server/services/githubService', () => ({
  GitHubService: {
    forSystem: (...args: unknown[]) => mockGitHubForSystem(...args),
  },
}));

vi.mock('@server/integrations/slack/sreSlackApproval', () => ({
  postSreRecurrenceDetectedMessage: (...args: unknown[]) => mockPostRecurrenceMessage(...args),
}));

const { escalateRecurrence } = await import('./escalation');

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const baseInput = {
  trackingId: 'tracking-1',
  fingerprint: 'fp-abcdef',
  priorFixPrNumbers: [7769, 7790],
  source: SreSourceType.GITHUB_ISSUE,
  issueNumber: 7735,
  repoSlug: 'owner/repo',
  sourceRef: 'https://github.com/owner/repo/issues/7735',
  rootCause: 'Ineffective workaround — stream-lifecycle bug',
  slackConfig: { workspaceId: 'W1', channelId: 'C1' },
};

describe('escalateRecurrence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasCommentWithMarker.mockResolvedValue(false); // default: no prior comment
    mockGitHubForSystem.mockResolvedValue({
      addIssueComment: (...args: unknown[]) => mockAddIssueComment(...args),
      hasCommentWithMarker: (...args: unknown[]) => mockHasCommentWithMarker(...args),
    });
    mockPostRecurrenceMessage.mockResolvedValue(undefined);
  });

  it('deactivates matched pattern when one exists', async () => {
    mockFindActiveByFingerprint.mockResolvedValue({ id: 'pattern-1', isActive: true });
    const logger = makeLogger();
    await escalateRecurrence({ ...baseInput, logger: logger as any });

    expect(mockUpdatePattern).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pattern-1', isActive: false, workaroundIneffective: true })
    );
  });

  it('gracefully skips pattern deactivation when no pattern exists', async () => {
    mockFindActiveByFingerprint.mockResolvedValue(null);
    const logger = makeLogger();
    await escalateRecurrence({ ...baseInput, logger: logger as any });

    expect(mockUpdatePattern).not.toHaveBeenCalled();
    // Slack + GitHub side effects still run
    expect(mockPostRecurrenceMessage).toHaveBeenCalled();
    expect(mockAddIssueComment).toHaveBeenCalled();
  });

  it('posts a GitHub issue comment for GITHUB_ISSUE source with issue number', async () => {
    mockFindActiveByFingerprint.mockResolvedValue(null);
    const logger = makeLogger();
    await escalateRecurrence({ ...baseInput, logger: logger as any });

    expect(mockAddIssueComment).toHaveBeenCalledWith(
      'owner/repo',
      7735,
      expect.stringContaining('Workaround Ineffective')
    );
    const body = mockAddIssueComment.mock.calls[0]![2] as string;
    expect(body).toContain('<!-- sre-recurrence-escalation -->');
    expect(body).toContain('#7769');
    expect(body).toContain('#7790');
  });

  it('skips GitHub comment for non-GITHUB_ISSUE sources', async () => {
    mockFindActiveByFingerprint.mockResolvedValue(null);
    const logger = makeLogger();
    await escalateRecurrence({
      ...baseInput,
      source: SreSourceType.CLOUDWATCH,
      issueNumber: undefined,
      logger: logger as any,
    });

    expect(mockAddIssueComment).not.toHaveBeenCalled();
    expect(mockPostRecurrenceMessage).toHaveBeenCalled();
  });

  it('includes rootCauseTrackingIssue in comment body when provided', async () => {
    mockFindActiveByFingerprint.mockResolvedValue(null);
    const logger = makeLogger();
    await escalateRecurrence({ ...baseInput, rootCauseTrackingIssue: 7789, logger: logger as any });

    const body = mockAddIssueComment.mock.calls[0]![2] as string;
    expect(body).toContain('#7789');
  });

  it('says "not yet linked" in comment body when rootCauseTrackingIssue is missing', async () => {
    mockFindActiveByFingerprint.mockResolvedValue(null);
    const logger = makeLogger();
    await escalateRecurrence({ ...baseInput, logger: logger as any });

    const body = mockAddIssueComment.mock.calls[0]![2] as string;
    expect(body).toContain('not yet linked');
  });

  it('posts Slack alert with correct args', async () => {
    mockFindActiveByFingerprint.mockResolvedValue(null);
    const logger = makeLogger();
    await escalateRecurrence({ ...baseInput, rootCauseTrackingIssue: 7789, logger: logger as any });

    expect(mockPostRecurrenceMessage).toHaveBeenCalledWith(
      'tracking-1',
      'fp-abcdef',
      [7769, 7790],
      'owner/repo',
      7789,
      expect.stringContaining('Ineffective workaround'),
      'https://github.com/owner/repo/issues/7735',
      { workspaceId: 'W1', channelId: 'C1' }
    );
  });

  it('continues when Slack post throws — logs and does not propagate', async () => {
    mockFindActiveByFingerprint.mockResolvedValue(null);
    mockPostRecurrenceMessage.mockRejectedValue(new Error('slack is down'));
    const logger = makeLogger();
    await expect(escalateRecurrence({ ...baseInput, logger: logger as any })).resolves.toBeUndefined();
    // GitHub side still fired
    expect(mockAddIssueComment).toHaveBeenCalled();
    // Logged as non-fatal
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to post Slack'), expect.anything());
  });

  it('continues when GitHub comment throws — logs and Slack still fires', async () => {
    mockFindActiveByFingerprint.mockResolvedValue(null);
    mockAddIssueComment.mockRejectedValue(new Error('github is down'));
    const logger = makeLogger();
    await expect(escalateRecurrence({ ...baseInput, logger: logger as any })).resolves.toBeUndefined();
    expect(mockPostRecurrenceMessage).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to post GitHub'), expect.anything());
  });

  it('skips GitHub comment when forSystem returns null (no system-level App)', async () => {
    mockFindActiveByFingerprint.mockResolvedValue(null);
    mockGitHubForSystem.mockResolvedValue(null);
    const logger = makeLogger();
    await escalateRecurrence({ ...baseInput, logger: logger as any });
    expect(mockAddIssueComment).not.toHaveBeenCalled();
    // Slack still runs
    expect(mockPostRecurrenceMessage).toHaveBeenCalled();
  });

  it('skips GitHub comment when marker already exists on the issue (idempotency)', async () => {
    mockFindActiveByFingerprint.mockResolvedValue(null);
    mockHasCommentWithMarker.mockResolvedValue(true); // marker already present
    const logger = makeLogger();
    await escalateRecurrence({ ...baseInput, logger: logger as any });

    expect(mockAddIssueComment).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('already exists, skipping duplicate'),
      expect.anything()
    );
    // Slack still fires (idempotency is per-side-effect)
    expect(mockPostRecurrenceMessage).toHaveBeenCalled();
  });

  it('emits structured observability log with event=recurrence_detected', async () => {
    mockFindActiveByFingerprint.mockResolvedValue(null);
    const logger = makeLogger();
    await escalateRecurrence({ ...baseInput, logger: logger as any });

    expect(logger.warn).toHaveBeenCalledWith(
      '[SRE-RECURRENCE] recurrence_detected',
      expect.objectContaining({
        event: 'recurrence_detected',
        trackingId: 'tracking-1',
        priorFixCount: 2,
        priorFixPrNumbers: [7769, 7790],
      })
    );
  });
});
