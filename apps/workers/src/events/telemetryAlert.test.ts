/**
 * The alert's requestId is the quest id (ChatCompletionProcess emits `requestId: questId`). Quest has no
 * top-level requestId field, so the handler must hand it on as a quest id, never filter on it itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const QUEST_ID = '65f0c0ffee0123456789abcd';

const h = vi.hoisted(() => ({
  cacheTelemetryAnalysisOnQuest: vi.fn(),
  createTelemetryIssue: vi.fn(),
  analysis: { findings: [], severity: 'warning' } as Record<string, unknown>,
}));

// Passthrough the wrapper so the raw handler runs without connectDB / Config.
vi.mock('@workers/utils/eventContext', () => ({
  withEventContext: (fn: unknown) => fn,
}));

vi.mock('@server/utils/eventBus', () => ({
  TelemetryEvents: { Alert: { schema: { parse: (properties: unknown) => properties } } },
}));

vi.mock('@server/utils/telemetryAnalysisCache', () => ({
  cacheTelemetryAnalysisOnQuest: h.cacheTelemetryAnalysisOnQuest,
}));

vi.mock('@server/utils/telemetryIssueCreator', () => ({
  getFallbackPriority: () => 'P2',
  fetchExistingTelemetryIssues: async () => [],
  fetchRecentlyClosedIssues: async () => [],
  createTelemetryIssue: h.createTelemetryIssue,
}));

vi.mock('@server/utils/telemetryAnalysis', () => ({
  DEFAULT_SLOS: {},
  computeHistoricalBaselines: async () => null,
  generateRuleBasedAnalysis: () => h.analysis,
  generateLLMAnalysis: vi.fn(),
}));

vi.mock('@server/services/githubService', () => ({
  GitHubService: { forSystem: async () => ({}) },
}));

vi.mock('@bike4mind/database', () => ({
  slackDevWorkspaceRepository: {},
  telemetryDryRunResultRepository: { createResult: vi.fn() },
  adminSettingsRepository: { getSettingsValue: async () => null },
  cacheRepository: {
    claimDedup: async () => ({ claimed: true }),
    incrementCounterConditional: async () => ({ success: true, count: 1 }),
    decrementCounter: vi.fn(),
  },
}));

vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptToken: vi.fn() }));
vi.mock('@bike4mind/slack', () => ({ SlackClient: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ AnomalyAlertService: vi.fn() }));

vi.mock('@bike4mind/server-utils/services/telemetryFingerprint', () => ({
  generateTelemetryFingerprint: () => 'fp',
  generateSemanticTelemetryFingerprint: () => 'sfp',
  getSeverityEmoji: () => '',
  formatPrimaryAnomaly: () => '',
}));

vi.mock('@bike4mind/server-utils/services/issueDedup', () => ({
  checkFingerprintDedup: () => ({ isDuplicate: false, isRegression: false }),
}));

import { handler } from './telemetryAlert';

const logger = {
  updateMetadata: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const run = (properties: Record<string, unknown>) =>
  (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)({ properties }, logger);

const autoAlert = (requestId: string) => ({
  requestId,
  telemetry: {
    anomalies: { anomalyScore: 90, severity: 'critical', primaryAnomaly: 'latency' },
    model: { modelId: 'm', provider: 'p' },
  },
  alertConfig: { autoCreateIssues: true, githubOwner: 'o', githubRepo: 'r', alertThreshold: 50 },
});

describe('telemetryAlert handler quest id wiring', () => {
  beforeEach(() => {
    h.cacheTelemetryAnalysisOnQuest.mockReset();
    h.createTelemetryIssue.mockReset().mockResolvedValue({ status: 'created', issue: { html_url: 'u' } });
  });

  it('caches the analysis on the quest named by requestId', async () => {
    await run(autoAlert(QUEST_ID));

    expect(h.cacheTelemetryAnalysisOnQuest).toHaveBeenCalledWith(
      QUEST_ID,
      expect.objectContaining({ analysis: h.analysis })
    );
  });

  it('hands requestId to createTelemetryIssue as questId', async () => {
    await run(autoAlert(QUEST_ID));

    expect(h.createTelemetryIssue).toHaveBeenCalledWith(expect.objectContaining({ questId: QUEST_ID }));
  });
});
