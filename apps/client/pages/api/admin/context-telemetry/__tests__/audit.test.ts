// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Record<string, Handler>>,
  current: '',
  audit: vi.fn(),
  findById: vi.fn(),
  updateOne: vi.fn(),
  auditLogCreate: vi.fn(),
  getSettingsValue: vi.fn(),
  createResult: vi.fn(),
  createIssue: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const bucket: Record<string, Handler> = {};
    h.handlers[h.current] = bucket;
    const chain: Record<string, unknown> = {};
    for (const method of ['get', 'post', 'delete']) {
      chain[method] = (fn: Handler) => {
        bucket[method] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Handler) => fn }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
vi.mock('@server/utils/telemetryProjection', () => ({ TELEMETRY_SAFE_PROJECTION: 'promptMeta.contextTelemetry' }));
vi.mock('@bike4mind/database', () => ({
  Quest: { findById: h.findById, updateOne: h.updateOne },
  telemetryAuditLogRepository: { createLog: h.auditLogCreate },
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  telemetryDryRunResultRepository: { createResult: h.createResult },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));
vi.mock('@server/utils/telemetryAnalysis', () => ({
  computeHistoricalBaselines: vi.fn().mockResolvedValue(null),
  generateRuleBasedAnalysis: vi.fn().mockReturnValue({ summary: 'rule based' }),
  generateLLMAnalysis: vi.fn(),
  DEFAULT_SLOS: {
    sloResponseTimeP95Ms: 1,
    sloFirstTokenTimeMs: 1,
    sloErrorRatePercent: 1,
    sloContextUtilizationPercent: 1,
  },
}));
vi.mock('@server/utils/telemetryIssueCreator', () => ({
  createTelemetryIssue: h.createIssue,
  getFallbackPriority: () => 'p2',
  fetchExistingTelemetryIssues: vi.fn(),
  fetchRecentlyClosedIssues: vi.fn(),
}));
vi.mock('@server/services/telemetryFingerprint', () => ({
  generateTelemetryFingerprint: () => 'fp',
  generateSemanticTelemetryFingerprint: () => 'sfp',
  getSeverityEmoji: () => '',
  formatPrimaryAnomaly: () => '',
}));
vi.mock('@bike4mind/server-utils/services/issueDedup', () => ({ checkFingerprintDedup: vi.fn() }));
vi.mock('@server/services/githubService', () => ({ GitHubService: { forSystem: vi.fn() } }));

const QUEST_ID = '64b7f0f0f0f0f0f0f0f0f0f0';

h.current = 'delete';
await import('../../context-telemetry/[id]');
h.current = 'analyze';
await import('../../context-telemetry/[id]/analyze');
h.current = 'createIssue';
await import('../../context-telemetry/[id]/create-issue');
h.current = 'testConfig';
await import('../test-config');

const telemetry = {
  anomalies: { anomalyScore: 10, severity: 'low', primaryAnomaly: 'none' },
  model: { modelId: 'm', provider: 'p' },
  contextWindow: { inputTokens: 1, utilizationPercentage: 1 },
  performance: { totalResponseTimeMs: 1 },
};
const quest = { _id: QUEST_ID, timestamp: new Date(), promptMeta: { contextTelemetry: telemetry } };

const query = (value: unknown) =>
  Object.assign(Promise.resolve(value), { select: () => ({ lean: () => Promise.resolve(value) }) });

const run = async (bucket: string, method: string, opts: { query?: Record<string, string>; body?: object } = {}) => {
  const { req, res } = createMocks({
    method: method.toUpperCase() as 'POST',
    query: opts.query ?? { id: QUEST_ID },
    body: opts.body ?? {},
  });
  const mutable = req as unknown as Record<string, unknown>;
  mutable.user = { id: 'admin-1', isAdmin: true };
  mutable.headers = { 'user-agent': 'test' };
  await h.handlers[bucket][method](req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.auditLogCreate.mockResolvedValue(undefined);
  h.updateOne.mockResolvedValue({ modifiedCount: 1 });
  h.getSettingsValue.mockResolvedValue(undefined);
});

describe('context telemetry admin audit', () => {
  it('records a telemetry deletion after the unset succeeds', async () => {
    h.findById.mockReturnValueOnce(query(quest)).mockReturnValueOnce(query({ promptMeta: {} }));

    const { req, res } = await run('delete', 'delete');

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.context_telemetry.deleted',
      target: { kind: 'system', id: QUEST_ID },
    });
    expect(h.updateOne.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('does not audit a deletion that finds no telemetry', async () => {
    h.findById.mockReturnValueOnce(query({ promptMeta: {} }));

    await expect(run('delete', 'delete')).rejects.toThrow();

    expect(h.audit).not.toHaveBeenCalled();
  });

  it('records a fresh analysis', async () => {
    h.findById.mockReturnValue(query(quest));

    const { req } = await run('analyze', 'post');

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.context_telemetry.analyzed',
      target: { kind: 'system', id: QUEST_ID },
      details: { questId: QUEST_ID, analysisSource: 'rule-based', forced: false },
    });
  });

  it('does not audit a cached analysis, which ran nothing', async () => {
    const cached = { ...telemetry, cachedAnalysis: { analysis: {}, analysisSource: 'llm', cachedAt: 'x' } };
    h.findById.mockReturnValue(query({ ...quest, promptMeta: { contextTelemetry: cached } }));

    await run('analyze', 'post');

    expect(h.audit).not.toHaveBeenCalled();
  });

  it('records a created issue', async () => {
    h.findById.mockReturnValue(query(quest));
    h.createIssue.mockResolvedValue({
      status: 'created',
      hasAnalysis: false,
      issue: { number: 7, html_url: 'u', title: 't', state: 'open', labels: [] },
    });

    const { req } = await run('createIssue', 'post', { body: { repository: 'acme/repo' } });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.context_telemetry.issue_created',
      target: { kind: 'system', id: QUEST_ID },
      details: { questId: QUEST_ID, repository: 'acme/repo', issueNumber: 7 },
    });
  });

  it('does not audit a duplicate issue', async () => {
    h.findById.mockReturnValue(query(quest));
    h.createIssue.mockResolvedValue({ status: 'duplicate', existingIssue: { number: 3, html_url: 'u' } });

    const { res } = await run('createIssue', 'post', { body: { repository: 'acme/repo' } });

    expect(res._getStatusCode()).toBe(409);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('records a config test run on sample data', async () => {
    h.createResult.mockResolvedValue({
      id: 'r1',
      timestamp: new Date(),
      source: 'test',
      telemetrySummary: {},
      action: {},
      fingerprint: 'fp',
      semanticFingerprint: 'sfp',
      expiresAt: new Date(),
    });

    const { req } = await run('testConfig', 'post', { query: {}, body: { sampleType: 'low' } });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.context_telemetry.test_run',
      target: { kind: 'system', id: 'context-telemetry-test-config' },
      details: { source: 'sample', sampleType: 'low', wouldCreateIssue: false },
    });
    expect(h.createResult.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});
