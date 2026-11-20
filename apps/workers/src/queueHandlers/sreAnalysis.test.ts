import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSettingsValue = vi.fn();
const mockClaimForAnalysis = vi.fn();
const mockUpdateStatus = vi.fn();
const mockPublish = vi.fn();
const mockDiagnose = vi.fn();
const mockPostSreApprovalMessage = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args) },
  apiKeyRepository: {},
  inboxRepository: {},
  sreErrorPatternRepository: {},
  sreErrorTrackingRepository: {
    claimForAnalysis: (...args: unknown[]) => mockClaimForAnalysis(...args),
    updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
    countConsecutiveFailures: vi.fn().mockResolvedValue(0),
    hasRecentFixForFiles: vi.fn().mockResolvedValue(false),
    findMergedFixesForFingerprint: vi.fn().mockResolvedValue([]),
    countFixesDispatchedToday: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  SreEvents: { AnalysisCompleted: { publish: (...args: unknown[]) => mockPublish(...args) } },
}));

vi.mock('@bike4mind/services/sreAgentService', () => ({
  SreAgentService: class {
    diagnose(...args: unknown[]) {
      return mockDiagnose(...args);
    }
  },
}));

vi.mock('@bike4mind/services/sreAgentService/tools', () => ({
  RATE_LIMITED_SENTINEL: 'GitHub code-search rate limited',
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@bike4mind/utils', () => ({
  getSettingsByNames: vi.fn().mockResolvedValue({}),
}));

vi.mock('@bike4mind/server-utils/services/githubService', () => ({
  GitHubService: {
    forSystem: vi.fn().mockResolvedValue({
      getFileContent: vi.fn(),
      searchCode: vi.fn(),
      listDirectoryContents: vi.fn(),
      listIssueComments: vi.fn().mockResolvedValue([]),
    }),
  },
  GitHubRateLimitError: class GitHubRateLimitError extends Error {},
}));

vi.mock('@bike4mind/server-utils/integrations/slack/sreSlackApproval', () => ({
  postSreApprovalMessage: (...args: unknown[]) => mockPostSreApprovalMessage(...args),
  postSreScopeBlockedMessage: vi.fn(),
  postSreNoFixNeededMessage: vi.fn(),
  postSreFixLoopMessage: vi.fn(),
  postSreLowConfidenceMessage: vi.fn(),
  postSreRateLimitedMessage: vi.fn(),
  postSreAnalysisFailureMessage: vi.fn(),
}));

vi.mock('@workers/integrations/sre/escalation', () => ({ escalateRecurrence: vi.fn() }));
vi.mock('@workers/integrations/sre/wontFixComment', () => ({
  buildWontFixCommentBody: vi.fn(),
  WONT_FIX_COMMENT_MARKER: '<!-- sre-wont-fix -->',
}));

import { SreSourceType } from '@bike4mind/common';
import { runSreAnalysis } from './sreAnalysis';

const REPO_SLUG = 'acme/app';

function makeConfig(gateOverrides: Record<string, unknown>) {
  return {
    repos: [
      {
        owner: 'acme',
        repo: 'app',
        enabled: true,
        dryRun: false,
        gates: {
          diagnosticianToSurgeon: {
            enabled: true,
            autoThreshold: 85,
            askThreshold: 60,
            approvalTimeoutHours: 12,
            autoDispatchSources: [],
            ...gateOverrides,
          },
        },
      },
    ],
  };
}

function makePayload(source: SreSourceType) {
  return {
    source,
    fingerprint: 'fp-abc12345',
    repoSlug: REPO_SLUG,
    errorMessage: 'boom',
    dryRun: false,
    issueNumber: source === SreSourceType.GITHUB_ISSUE ? 7 : undefined,
  } as never;
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

describe('runSreAnalysis diagnostician gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimForAnalysis.mockResolvedValue({ id: 'track-1' });
    mockDiagnose.mockResolvedValue({
      diagnosis: {
        rootCause: 'bad lock',
        proposedFix: 'add lock',
        confidence: 95,
        riskAssessment: 'low',
        affectedFiles: [{ filePath: 'a.ts', before: 'a', after: 'b', kind: 'replace' }],
      },
    });
  });

  it.each([
    ['GITHUB_ISSUE default', SreSourceType.GITHUB_ISSUE, {}],
    ['CLOUDWATCH default', SreSourceType.CLOUDWATCH, {}],
    ['gate disabled', SreSourceType.GITHUB_ISSUE, { enabled: false }],
    ['other source listed', SreSourceType.CLOUDWATCH, { autoDispatchSources: [SreSourceType.GITHUB_ISSUE] }],
  ])('requires approval and does not dispatch (%s)', async (_label, source, gate) => {
    mockGetSettingsValue.mockResolvedValue(makeConfig(gate));

    await runSreAnalysis(makePayload(source), logger);

    expect(mockUpdateStatus).toHaveBeenCalledWith('track-1', 'awaiting_approval');
    expect(mockPostSreApprovalMessage).toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('dispatches when the source is allow-listed', async () => {
    mockGetSettingsValue.mockResolvedValue(makeConfig({ autoDispatchSources: [SreSourceType.GITHUB_ISSUE] }));

    await runSreAnalysis(makePayload(SreSourceType.GITHUB_ISSUE), logger);

    expect(mockPostSreApprovalMessage).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});
