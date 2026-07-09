import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSettingsValue = vi.fn();
const mockIncrementCounterConditional = vi.fn();
const mockSendToQueue = vi.fn();
const mockGetSourceQueueUrl = vi.fn(() => 'https://sqs.example.com/sreJobQueue');
const mockResolveFullConfig = vi.fn();
const mockGetConfiguredRepoSlugs = vi.fn();
const mockSetGithubIssueState = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
  },
  cacheRepository: {
    incrementCounterConditional: (...args: unknown[]) => mockIncrementCounterConditional(...args),
  },
  sreErrorTrackingRepository: {
    setGithubIssueState: (...args: unknown[]) => mockSetGithubIssueState(...args),
  },
}));

vi.mock('@bike4mind/common', () => ({
  SreSourceType: { GITHUB_ISSUE: 'GITHUB_ISSUE' },
  SreClassification: { MEDIUM: 'MEDIUM' },
  SRE_DEFAULT_REPO_SLUG: 'MillionOnMars/lumina5',
  getConfiguredRepoSlugs: (...args: unknown[]) => mockGetConfiguredRepoSlugs(...args),
  resolveFullConfig: (...args: unknown[]) => mockResolveFullConfig(...args),
}));

vi.mock('@server/utils/dlqRegistry', () => ({
  getSourceQueueUrl: (...args: unknown[]) => mockGetSourceQueueUrl(...args),
}));

vi.mock('@server/utils/sqs', () => ({
  sendToQueue: (...args: unknown[]) => mockSendToQueue(...args),
}));

import { dispatchIssueToSre, syncSreIssueStateFromWebhook, type SreIssuePayload } from './sreWebhookDispatch';

function makePayload(overrides: Partial<SreIssuePayload> = {}): SreIssuePayload {
  return {
    action: overrides.action ?? 'opened',
    issue: {
      title: overrides.issue?.title ?? 'TypeError: Cannot read property foo of undefined',
      number: overrides.issue?.number ?? 42,
      html_url: overrides.issue?.html_url ?? 'https://github.com/owner/repo/issues/42',
      body: overrides.issue?.body ?? 'stack trace here',
      labels: overrides.issue?.labels ?? [{ name: 'bug' }],
    },
    repository: overrides.repository ?? { full_name: 'MillionOnMars/lumina5' },
  };
}

const eligibleConfig = {
  enabled: true,
  dryRun: false,
  sources: { github: { enabled: true, labelFilter: { required: ['bug'], anyOf: [] } } },
};

describe('dispatchIssueToSre', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettingsValue.mockResolvedValue({ repos: [] });
    mockGetConfiguredRepoSlugs.mockReturnValue(['MillionOnMars/lumina5']);
    mockResolveFullConfig.mockReturnValue(eligibleConfig);
    mockIncrementCounterConditional.mockResolvedValue({ success: true, count: 1 });
    mockSendToQueue.mockResolvedValue(undefined);
  });

  describe('action allowlist', () => {
    it('rejects `closed` action — the regression that this issue is about', async () => {
      const result = await dispatchIssueToSre(makePayload({ action: 'closed' }));

      expect(result).toEqual({ dispatched: false, reason: 'action-not-eligible' });
      expect(mockSendToQueue).not.toHaveBeenCalled();
      // Action filter runs before any DB calls - should short-circuit immediately.
      expect(mockGetSettingsValue).not.toHaveBeenCalled();
    });

    it.each(['unlabeled', 'edited', 'deleted', 'assigned', 'milestoned', 'pinned', 'locked'])(
      'rejects `%s` action',
      async action => {
        const result = await dispatchIssueToSre(makePayload({ action }));

        expect(result).toEqual({ dispatched: false, reason: 'action-not-eligible' });
        expect(mockSendToQueue).not.toHaveBeenCalled();
      }
    );

    it('allows `opened` action through the gate', async () => {
      const result = await dispatchIssueToSre(makePayload({ action: 'opened' }));

      expect(result).toEqual({ dispatched: true });
      expect(mockSendToQueue).toHaveBeenCalledTimes(1);
    });

    it('dispatches to the merged sreJobQueue tagged jobType: analysis', async () => {
      await dispatchIssueToSre(makePayload({ action: 'opened' }));

      expect(mockGetSourceQueueUrl).toHaveBeenCalledWith('sreJobQueue');
      const [url, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toContain('sreJobQueue');
      expect(payload.jobType).toBe('analysis');
    });

    it('allows `labeled` action through the gate (e.g. `bug` label added later)', async () => {
      const result = await dispatchIssueToSre(makePayload({ action: 'labeled' }));

      expect(result).toEqual({ dispatched: true });
      expect(mockSendToQueue).toHaveBeenCalledTimes(1);
    });

    it('allows `reopened` action through the gate — fix-loop guard catches "fix didn\'t work"', async () => {
      const result = await dispatchIssueToSre(makePayload({ action: 'reopened' }));

      expect(result).toEqual({ dispatched: true });
      expect(mockSendToQueue).toHaveBeenCalledTimes(1);
    });

    // Synthetic actions used by internal admin endpoints. Must pass the gate or
    // /api/sre/trigger, /api/sre/tracking/:id/retry, and /api/sre/tracking/:id/rerun
    // will silently break.
    it.each(['manual-trigger', 'retry', 'rerun'])(
      'allows synthetic admin action `%s` through the gate',
      async action => {
        const result = await dispatchIssueToSre(makePayload({ action }));

        expect(result).toEqual({ dispatched: true });
        expect(mockSendToQueue).toHaveBeenCalledTimes(1);
      }
    );
  });

  describe('triggerAction propagation', () => {
    it('forwards `reopened` as triggerAction on the SRE payload', async () => {
      await dispatchIssueToSre(makePayload({ action: 'reopened' }));

      expect(mockSendToQueue).toHaveBeenCalledTimes(1);
      const [, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload.triggerAction).toBe('reopened');
    });

    it('forwards `opened` as triggerAction on the SRE payload', async () => {
      await dispatchIssueToSre(makePayload({ action: 'opened' }));

      const [, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload.triggerAction).toBe('opened');
    });

    it('forwards `labeled` as triggerAction on the SRE payload', async () => {
      await dispatchIssueToSre(makePayload({ action: 'labeled' }));

      const [, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload.triggerAction).toBe('labeled');
    });

    it('omits triggerAction for synthetic admin actions (manual-trigger / retry / rerun)', async () => {
      // Admin endpoints don't have a webhook action; leave the flag undefined so
      // the fix-loop alert falls back to the generic recurrence message.
      await dispatchIssueToSre(makePayload({ action: 'manual-trigger' }));
      const [, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload.triggerAction).toBeUndefined();
    });
  });

  describe('downstream filters remain unaffected', () => {
    it('still applies the label filter after the action gate passes', async () => {
      const result = await dispatchIssueToSre(
        makePayload({
          action: 'opened',
          issue: {
            title: 'No bug label',
            number: 99,
            html_url: 'https://github.com/owner/repo/issues/99',
            body: '',
            labels: [{ name: 'enhancement' }],
          },
        })
      );

      expect(result).toEqual({ dispatched: false, reason: 'label-mismatch' });
      expect(mockSendToQueue).not.toHaveBeenCalled();
    });
  });

  describe('dispatch reason coverage', () => {
    it('returns `pipeline-disabled` when sreAgentConfig is missing', async () => {
      mockGetSettingsValue.mockResolvedValue(undefined);

      const result = await dispatchIssueToSre(makePayload());

      expect(result).toEqual({ dispatched: false, reason: 'pipeline-disabled' });
      expect(mockSendToQueue).not.toHaveBeenCalled();
    });

    it('returns `repo-mismatch` when issue repo is not in configured repos', async () => {
      mockGetConfiguredRepoSlugs.mockReturnValue(['MillionOnMars/some-other-repo']);

      const result = await dispatchIssueToSre(makePayload());

      expect(result).toEqual({ dispatched: false, reason: 'repo-mismatch' });
      expect(mockSendToQueue).not.toHaveBeenCalled();
    });

    it('returns `repo-not-configured` when resolveFullConfig returns null', async () => {
      mockResolveFullConfig.mockReturnValue(null);

      const result = await dispatchIssueToSre(makePayload());

      expect(result).toEqual({ dispatched: false, reason: 'repo-not-configured' });
      expect(mockSendToQueue).not.toHaveBeenCalled();
    });

    it('returns `repo-disabled` when repoConfig.enabled is false', async () => {
      mockResolveFullConfig.mockReturnValue({ ...eligibleConfig, enabled: false });

      const result = await dispatchIssueToSre(makePayload());

      expect(result).toEqual({ dispatched: false, reason: 'repo-disabled' });
      expect(mockSendToQueue).not.toHaveBeenCalled();
    });

    it('returns `github-source-disabled` when sources.github.enabled is false', async () => {
      mockResolveFullConfig.mockReturnValue({
        ...eligibleConfig,
        sources: { github: { enabled: false, labelFilter: { required: ['bug'], anyOf: [] } } },
      });

      const result = await dispatchIssueToSre(makePayload());

      expect(result).toEqual({ dispatched: false, reason: 'github-source-disabled' });
      expect(mockSendToQueue).not.toHaveBeenCalled();
    });

    it('returns `already-dispatched` when fingerprint dedup hits', async () => {
      mockIncrementCounterConditional.mockResolvedValue({ success: false, count: 2 });

      const result = await dispatchIssueToSre(makePayload());

      expect(result).toEqual({ dispatched: false, reason: 'already-dispatched' });
      expect(mockSendToQueue).not.toHaveBeenCalled();
    });
  });
});

describe('syncSreIssueStateFromWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetGithubIssueState.mockResolvedValue(1);
  });

  it('sets githubIssueState to `closed` on a `closed` action', async () => {
    await syncSreIssueStateFromWebhook(makePayload({ action: 'closed' }));

    expect(mockSetGithubIssueState).toHaveBeenCalledTimes(1);
    expect(mockSetGithubIssueState).toHaveBeenCalledWith('MillionOnMars/lumina5', 42, 'closed');
  });

  it('sets githubIssueState to `open` on a `reopened` action', async () => {
    await syncSreIssueStateFromWebhook(makePayload({ action: 'reopened' }));

    expect(mockSetGithubIssueState).toHaveBeenCalledTimes(1);
    expect(mockSetGithubIssueState).toHaveBeenCalledWith('MillionOnMars/lumina5', 42, 'open');
  });

  it.each(['opened', 'labeled', 'edited', 'assigned', 'manual-trigger'])(
    'no-ops for the non-state-changing `%s` action',
    async action => {
      await syncSreIssueStateFromWebhook(makePayload({ action }));

      expect(mockSetGithubIssueState).not.toHaveBeenCalled();
    }
  );

  it('no-ops when the repository is missing (cannot scope the update)', async () => {
    const payload = makePayload({ action: 'closed' });
    delete (payload as { repository?: unknown }).repository;

    await syncSreIssueStateFromWebhook(payload);

    expect(mockSetGithubIssueState).not.toHaveBeenCalled();
  });

  it('swallows repository errors so the webhook is never failed by a state write', async () => {
    mockSetGithubIssueState.mockRejectedValue(new Error('DB down'));

    await expect(syncSreIssueStateFromWebhook(makePayload({ action: 'closed' }))).resolves.toBeUndefined();
  });
});
