import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockForSystem = vi.fn();
const mockEmitMetric = vi.fn();
const mockServiceRun = vi.fn();
const mockServicePrepare = vi.fn();
const mockFindOne = vi.fn();
const mockRecordRun = vi.fn();
const mockRepoCheck = vi.fn();
const mockSafeParse = vi.fn();
const mockSlackSend = vi.fn();
const mockDecryptToken = vi.fn();
const mockFindWorkspace = vi.fn();
const mockExecutionStatus = vi.fn();
const mockClaimExecution = vi.fn();
const mockCompleteExecution = vi.fn();
const mockRecoverAccounting = vi.fn();
const accountingContext = { attribution: { executionId: 'secops-execution-' + 'a'.repeat(64) } };

vi.mock('@bike4mind/server-utils/services/githubService', () => ({
  GitHubService: {
    forSystem: (...args: unknown[]) => mockForSystem(...args),
  },
}));

vi.mock('@bike4mind/server-utils/security/secopsTriageRepoCheck', () => ({
  checkSecopsTriageRepo: (...args: unknown[]) => mockRepoCheck(...args),
}));

vi.mock('@workers/services/secopsTriageService', () => ({
  createSecopsTriageService: () => ({
    run: (...args: unknown[]) => mockServiceRun(...args),
    prepare: (...args: unknown[]) => mockServicePrepare(...args),
  }),
}));

vi.mock('@workers/services/secopsTriageAccounting', () => ({
  createSecopsTriageAccounting: () => accountingContext,
  recoverSecopsTriageAccounting: (...args: unknown[]) => mockRecoverAccounting(...args),
}));

vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  emitMetric: (...args: unknown[]) => mockEmitMetric(...args),
}));

vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  decryptToken: (...args: unknown[]) => mockDecryptToken(...args),
}));

vi.mock('@bike4mind/slack', () => ({
  SlackClient: vi.fn(function () {
    return { sendMessage: (...args: unknown[]) => mockSlackSend(...args) };
  }),
}));

vi.mock('@bike4mind/database', () => ({
  AdminSettings: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
  secopsTriageRunRepository: {
    record: (...args: unknown[]) => mockRecordRun(...args),
    executionStatus: (...args: unknown[]) => mockExecutionStatus(...args),
    claimExecution: (...args: unknown[]) => mockClaimExecution(...args),
    completeExecution: (...args: unknown[]) => mockCompleteExecution(...args),
  },
  slackDevWorkspaceRepository: {
    findByIdWithToken: (...args: unknown[]) => mockFindWorkspace(...args),
    findAllActive: vi.fn().mockResolvedValue([]),
    findBySlackTeamIdWithToken: vi.fn(),
  },
}));

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  SECOPS_TRIAGE_SCAN_SOURCES: ['web-owasp', 'secrets', 'packages', 'code-semgrep', 'cloud', 'active-defense'] as const,
  SecopsTriageConfigSchema: {
    safeParse: (v: unknown) => mockSafeParse(v),
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

vi.mock('sst', () => ({
  Resource: { App: { stage: 'dev' } },
}));

// Passthrough so we can invoke the inner handler directly with (event, context, logger)
vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { handler } from './secopsTriageWorker';
import { PlatformCompletionAccountingError } from '@bike4mind/services';

function makeSqsEvent(body: Record<string, unknown>) {
  return { Records: [{ body: JSON.stringify(body) }] } as never;
}

const mockContext = { getRemainingTimeInMillis: () => 180_000 } as never;
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
};

const validPayload = {
  stage: 'dev',
  scanSource: 'active-defense',
  findings: [
    {
      id: 'finding-1',
      title: 'probe target not present',
      severity: 'low',
      instances: [],
    },
  ],
};

const run = () => handler(makeSqsEvent(validPayload), mockContext, mockLogger as never);

const serviceResult = {
  issuesCreated: 1,
  issuesUpdated: 2,
  issuesReopened: 3,
  issuesClosed: 4,
  issuesDeduplicated: 2,
  issuesSuppressed: 5,
  skippedBelowThreshold: 6,
  skippedRateLimit: 7,
};

const recordedRun = () => {
  expect(mockRecordRun).toHaveBeenCalledOnce();
  return mockRecordRun.mock.calls[0][0];
};

describe('secopsTriageWorker handler', () => {
  beforeEach(() => {
    mockServicePrepare.mockImplementation(async (config: { llmEnrichment?: boolean; modelId?: string }) =>
      Boolean(config.llmEnrichment && config.modelId)
    );
    vi.clearAllMocks();
    mockFindOne.mockResolvedValue({ settingValue: { enabled: true } });
    mockSafeParse.mockImplementation((v: unknown) => ({
      success: true,
      data: { enabled: true, dryRun: false, githubRepo: 'test-org/test-repo', ...(v as Record<string, unknown>) },
    }));
    mockEmitMetric.mockResolvedValue(undefined);
    mockRecordRun.mockResolvedValue({});
    mockExecutionStatus.mockResolvedValue(null);
    mockClaimExecution.mockResolvedValue(true);
    mockCompleteExecution.mockResolvedValue(undefined);
    mockRecoverAccounting.mockResolvedValue(undefined);
    mockRepoCheck.mockResolvedValue({ ok: true });
    mockDecryptToken.mockReturnValue(null);
    mockFindWorkspace.mockResolvedValue(null);
    mockSlackSend.mockResolvedValue(undefined);
  });

  it('does not dead-letter when there is no system GitHub connection', async () => {
    // forSystem returns null in dev (no b4m-prod GitHub App) - a permanent condition
    mockForSystem.mockResolvedValue(null);

    // Must resolve (return), not throw - throwing would route the message to the DLQ
    await expect(run()).resolves.toBeUndefined();

    expect(mockServiceRun).not.toHaveBeenCalled();
    expect(recordedRun()).toMatchObject({
      stage: 'dev',
      scanSource: 'active-defense',
      status: 'skipped',
      reason: 'no_github_connection',
      findingCount: 1,
      startedAt: expect.any(Date),
    });
  });

  it('still emits the NoGitHubConnection failure metric so the condition stays observable', async () => {
    mockForSystem.mockResolvedValue(null);

    await run();

    expect(mockEmitMetric).toHaveBeenCalledWith(
      'Lumina5/SecOpsTriage',
      'TriageRunFailure',
      1,
      { Stage: 'dev', ErrorType: 'NoGitHubConnection' },
      expect.anything()
    );
  });

  it('warns and records a skipped run when the saved config does not parse', async () => {
    mockSafeParse.mockReturnValue({
      success: false,
      error: { issues: [{ path: ['githubRepo'], message: 'A repository is required' }] },
    });

    await expect(run()).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('config is invalid'),
      expect.objectContaining({ issues: [{ path: 'githubRepo', message: 'A repository is required' }] })
    );
    expect(recordedRun()).toMatchObject({ status: 'skipped', reason: 'invalid_config', dryRun: false });
    expect(mockForSystem).not.toHaveBeenCalled();
    expect(mockServiceRun).not.toHaveBeenCalled();
  });

  it('records a skipped run when triage is disabled', async () => {
    mockFindOne.mockResolvedValue({ settingValue: { enabled: false, dryRun: true } });

    await expect(run()).resolves.toBeUndefined();

    expect(recordedRun()).toMatchObject({ status: 'skipped', reason: 'disabled', dryRun: true });
    expect(mockForSystem).not.toHaveBeenCalled();
  });

  describe('repository check', () => {
    beforeEach(() => {
      mockForSystem.mockResolvedValue({});
    });

    it.each(['not_configured', 'not_allowed', 'not_found', 'public', 'archived', 'issues_disabled'])(
      'skips without retrying when the repository is %s',
      async reason => {
        mockRepoCheck.mockResolvedValue({ ok: false, reason });

        await expect(run()).resolves.toBeUndefined();

        expect(mockRepoCheck).toHaveBeenCalledWith({}, 'test-org/test-repo');
        expect(mockServiceRun).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.stringContaining('repository cannot take issues'),
          expect.objectContaining({ reason })
        );
        expect(mockEmitMetric).toHaveBeenCalledWith(
          'Lumina5/SecOpsTriage',
          'TriageRunFailure',
          1,
          { Stage: 'dev', ErrorType: 'RepoNotWritable' },
          expect.anything()
        );
        expect(recordedRun()).toMatchObject({ status: 'skipped', reason });
      }
    );

    it('posts a short Slack message when a channel is configured and a token resolves', async () => {
      mockFindOne.mockResolvedValue({ settingValue: { slackChannelId: 'C123', slackWorkspaceId: 'ws-1' } });
      mockFindWorkspace.mockResolvedValue({ slackBotToken: 'encrypted' });
      mockDecryptToken.mockReturnValue('xoxb-test');
      mockRepoCheck.mockResolvedValue({ ok: false, reason: 'archived' });

      await run();

      expect(mockSlackSend).toHaveBeenCalledOnce();
      expect(mockSlackSend.mock.calls[0][0]).toMatchObject({
        channel: 'C123',
        text: expect.stringContaining('the repository is archived'),
      });
    });

    it('does not post to Slack when no channel is configured', async () => {
      mockRepoCheck.mockResolvedValue({ ok: false, reason: 'not_found' });

      await run();

      expect(mockSlackSend).not.toHaveBeenCalled();
    });

    it('still skips cleanly when the Slack message fails', async () => {
      mockFindOne.mockResolvedValue({ settingValue: { slackChannelId: 'C123', slackWorkspaceId: 'ws-1' } });
      mockFindWorkspace.mockResolvedValue({ slackBotToken: 'encrypted' });
      mockDecryptToken.mockReturnValue('xoxb-test');
      mockRepoCheck.mockResolvedValue({ ok: false, reason: 'archived' });
      mockSlackSend.mockRejectedValue(new Error('slack down'));

      await expect(run()).resolves.toBeUndefined();

      expect(recordedRun()).toMatchObject({ status: 'skipped', reason: 'archived' });
    });

    it('records a failed run and rethrows when the repository lookup itself fails', async () => {
      mockRepoCheck.mockRejectedValue(new Error('GitHub unavailable'));

      await expect(run()).rejects.toThrow('GitHub unavailable');

      expect(mockServiceRun).not.toHaveBeenCalled();
      expect(recordedRun()).toMatchObject({ status: 'failed', error: 'GitHub unavailable' });
    });
  });

  describe('runs that reach the service', () => {
    beforeEach(() => {
      mockForSystem.mockResolvedValue({});
    });

    it('records a completed run with its counts and duration', async () => {
      mockServiceRun.mockResolvedValue(serviceResult);

      await expect(run()).resolves.toBeUndefined();

      expect(recordedRun()).toEqual({
        stage: 'dev',
        scanSource: 'active-defense',
        findingCount: 1,
        startedAt: expect.any(Date),
        status: 'completed',
        dryRun: false,
        durationMs: expect.any(Number),
        counts: { created: 1, updated: 2, reopened: 3, closed: 4, suppressed: 5, belowThreshold: 6, overCap: 7 },
      });
    });

    it('emits the reopened and suppressed counts alongside the existing metrics', async () => {
      mockServiceRun.mockResolvedValue(serviceResult);

      await run();

      const emitted = Object.fromEntries(mockEmitMetric.mock.calls.map(([, name, value]) => [name, value]));
      expect(emitted).toMatchObject({
        IssuesCreated: 1,
        IssuesUpdated: 2,
        IssuesReopened: 3,
        IssuesClosed: 4,
        IssuesSuppressed: 5,
        IssuesDeduplicated: 2,
        TriageRunSuccess: 1,
      });
    });

    it('records a failed run with the error message and rethrows', async () => {
      mockServiceRun.mockRejectedValue(new Error('rate limited'));

      await expect(run()).rejects.toThrow('rate limited');

      expect(recordedRun()).toMatchObject({ status: 'failed', error: 'rate limited', durationMs: expect.any(Number) });
      expect(mockEmitMetric).toHaveBeenCalledWith(
        'Lumina5/SecOpsTriage',
        'TriageRunFailure',
        1,
        { Stage: 'dev', ErrorType: 'RuntimeError' },
        expect.anything()
      );
    });

    it('keeps the outcome when recording the run fails', async () => {
      mockRecordRun.mockRejectedValue(new Error('mongo down'));
      mockServiceRun.mockResolvedValue(serviceResult);
      await expect(run()).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not record the triage run'),
        expect.objectContaining({ error: 'mongo down' })
      );

      mockServiceRun.mockRejectedValue(new Error('rate limited'));
      await expect(run()).rejects.toThrow('rate limited');

      mockForSystem.mockResolvedValue(null);
      await expect(run()).resolves.toBeUndefined();
    });
  });

  describe('auto-close scope fields', () => {
    beforeEach(() => {
      mockForSystem.mockResolvedValue({});
      mockServiceRun.mockResolvedValue({
        issuesCreated: 0,
        issuesUpdated: 0,
        issuesClosed: 0,
        issuesDeduplicated: 0,
      });
    });

    it('defaults findingsComplete to true and unverifiedFindingIds to an empty list', async () => {
      await run();

      expect(mockServiceRun).toHaveBeenCalledOnce();
      const [payload] = mockServiceRun.mock.calls[0];
      expect(payload).toMatchObject({ findingsComplete: true, unverifiedFindingIds: [] });
    });

    it('passes explicit findingsComplete and unverifiedFindingIds through to the service', async () => {
      await handler(
        makeSqsEvent({ ...validPayload, findingsComplete: false, unverifiedFindingIds: ['probe-a', 'probe-b'] }),
        mockContext,
        mockLogger as never
      );

      expect(mockServiceRun).toHaveBeenCalledOnce();
      const [payload] = mockServiceRun.mock.calls[0];
      expect(payload).toMatchObject({ findingsComplete: false, unverifiedFindingIds: ['probe-a', 'probe-b'] });
    });
  });
  describe('durable execution isolation', () => {
    beforeEach(() => {
      mockFindOne.mockResolvedValue({ settingValue: { enabled: true, llmEnrichment: true, modelId: 'test-model' } });
      mockForSystem.mockResolvedValue({});
      mockServiceRun.mockResolvedValue(serviceResult);
    });

    it('acknowledges completed redelivery after receipt recovery without rerunning the service', async () => {
      mockExecutionStatus.mockResolvedValue('completed');
      await run();
      expect(mockRecoverAccounting).toHaveBeenCalledOnce();
      expect(mockClaimExecution).not.toHaveBeenCalled();
      expect(mockServiceRun).not.toHaveBeenCalled();
    });

    it('recovers completed unresolved accounting with the explicit replay allowance and never reruns business work', async () => {
      mockExecutionStatus.mockResolvedValue('completed');
      await run();
      expect(mockRecoverAccounting).toHaveBeenCalledWith(accountingContext, true);
      expect(mockServicePrepare).not.toHaveBeenCalled();
      expect(mockServiceRun).not.toHaveBeenCalled();
    });

    it('does not acknowledge completed business work when recovery persistence fails', async () => {
      mockExecutionStatus.mockResolvedValue('completed');
      mockRecoverAccounting.mockRejectedValueOnce(new PlatformCompletionAccountingError('recovery_pending'));
      await expect(run()).rejects.toMatchObject({ reason: 'recovery_pending' });
      expect(mockServiceRun).not.toHaveBeenCalled();
    });

    it('preflights unsupported optional enrichment before claiming and keeps ordinary triage', async () => {
      mockServicePrepare.mockResolvedValueOnce(false);
      await run();
      expect(mockServicePrepare).toHaveBeenCalledOnce();
      expect(mockClaimExecution).not.toHaveBeenCalled();
      expect(mockServiceRun).toHaveBeenCalledOnce();
      expect(mockCompleteExecution).not.toHaveBeenCalled();
    });

    it('claims only after successful preflight and completes a deterministic fallback without replay', async () => {
      await run();
      expect(mockServicePrepare.mock.invocationCallOrder[0]).toBeLessThan(
        mockClaimExecution.mock.invocationCallOrder[0]
      );
      expect(mockCompleteExecution).toHaveBeenCalledOnce();
      mockExecutionStatus.mockResolvedValue('completed');
      await run();
      expect(mockServiceRun).toHaveBeenCalledOnce();
      expect(mockCompleteExecution).toHaveBeenCalledOnce();
    });

    it('fails closed for concurrent delivery or a prior uncertain execution', async () => {
      mockExecutionStatus.mockResolvedValue('running');
      mockClaimExecution.mockResolvedValue(false);
      await expect(run()).rejects.toMatchObject({ reason: 'execution_requires_manual_recovery' });
      expect(mockServiceRun).not.toHaveBeenCalled();
      expect(mockCompleteExecution).not.toHaveBeenCalled();
    });

    it('leaves an execution claimed after a late accounting failure so redelivery cannot repeat GitHub work', async () => {
      let claimed = false;
      mockClaimExecution.mockImplementation(async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      });
      mockServiceRun.mockRejectedValueOnce(new PlatformCompletionAccountingError('settlement_failed', 'call-id'));
      await expect(run()).rejects.toMatchObject({ reason: 'settlement_failed' });
      mockExecutionStatus.mockResolvedValue('running');
      await expect(run()).rejects.toMatchObject({ reason: 'execution_requires_manual_recovery' });
      expect(mockServiceRun).toHaveBeenCalledOnce();
      expect(mockCompleteExecution).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(expect.any(String), {
        reason: 'settlement_failed',
        providerCallId: 'call-id',
      });
    });

    it('does not rerun business actions when writing the completion marker fails', async () => {
      mockCompleteExecution.mockRejectedValueOnce(new Error('private persistence detail'));
      await expect(run()).rejects.toMatchObject({ reason: 'execution_completion_failed' });
      mockExecutionStatus.mockResolvedValue('running');
      mockClaimExecution.mockResolvedValue(false);
      await expect(run()).rejects.toMatchObject({ reason: 'execution_requires_manual_recovery' });
      expect(mockServiceRun).toHaveBeenCalledOnce();
    });

    it.each(['lookup', 'claim'])('wraps %s datastore failure without exposing persistence details', async phase => {
      (phase === 'lookup' ? mockExecutionStatus : mockClaimExecution).mockRejectedValueOnce(
        new Error('private transport detail')
      );
      await expect(run()).rejects.toMatchObject({ reason: 'execution_claim_failed' });
      expect(mockServiceRun).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(expect.any(String), {
        reason: 'execution_claim_failed',
        providerCallId: undefined,
      });
    });

    it('does not claim or invoke business work when accounting recovery is pending', async () => {
      mockRecoverAccounting.mockRejectedValueOnce(new PlatformCompletionAccountingError('recovery_pending'));
      await expect(run()).rejects.toMatchObject({ reason: 'recovery_pending' });
      expect(mockClaimExecution).not.toHaveBeenCalled();
      expect(mockServiceRun).not.toHaveBeenCalled();
    });

    it('retains ordinary retry behavior for a new run with enrichment disabled', async () => {
      mockFindOne.mockResolvedValue({ settingValue: { enabled: true, llmEnrichment: false } });
      mockServiceRun
        .mockRejectedValueOnce(new Error('temporary issue-list failure'))
        .mockResolvedValueOnce(serviceResult);
      await expect(run()).rejects.toThrow('temporary issue-list failure');
      await expect(run()).resolves.toBeUndefined();
      expect(mockServiceRun).toHaveBeenCalledTimes(2);
      expect(mockClaimExecution).not.toHaveBeenCalled();
      expect(mockCompleteExecution).not.toHaveBeenCalled();
    });

    it('does not bypass an earlier running execution after enrichment is disabled', async () => {
      mockFindOne.mockResolvedValue({ settingValue: { enabled: true, llmEnrichment: false } });
      mockExecutionStatus.mockResolvedValue('running');
      await expect(run()).rejects.toMatchObject({ reason: 'execution_requires_manual_recovery' });
      expect(mockServiceRun).not.toHaveBeenCalled();
    });

    it('acknowledges an earlier completed execution after the model is removed', async () => {
      mockFindOne.mockResolvedValue({ settingValue: { enabled: true, llmEnrichment: true } });
      mockExecutionStatus.mockResolvedValue('completed');
      await expect(run()).resolves.toBeUndefined();
      expect(mockServiceRun).not.toHaveBeenCalled();
      expect(mockClaimExecution).not.toHaveBeenCalled();
    });

    it('persists the completion marker before nonessential metrics and run history', async () => {
      await run();
      expect(mockCompleteExecution.mock.invocationCallOrder[0]).toBeLessThan(mockRecordRun.mock.invocationCallOrder[0]);
      expect(mockCompleteExecution.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockServiceRun.mock.invocationCallOrder[0]
      );
    });
  });
});
