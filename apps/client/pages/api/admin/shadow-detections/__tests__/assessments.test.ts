import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ApiKeyScope,
  RISK_EVIDENCE_VERSION,
  type AbuseAssessmentItem,
  type ShadowDetectionItem,
} from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Record<string, (req: unknown, res: unknown) => Promise<void>>>,
  current: '',
  routeOptions: vi.fn(),
  listForDetection: vi.fn(),
  findById: vi.fn(),
  assess: vi.fn(),
  replay: vi.fn(),
  loadSettings: vi.fn(),
  summarize: vi.fn(),
  record: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
// The permission gate itself is adminApi's (covered by its own tests); these assert each route declares it.
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.routeOptions(options);
    const route = (h.handlers[h.current] = {} as Record<string, (req: unknown, res: unknown) => Promise<void>>);
    const chain = {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => Promise<void>) => {
        route.get = fn;
        return chain;
      },
      post: (fn: (req: unknown, res: unknown) => Promise<void>) => {
        route.post = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  abuseAssessmentRepository: { listForDetection: h.listForDetection },
  shadowDetectionRepository: { findById: h.findById },
}));
vi.mock('@server/security/abuseAssessment/abuseAssessment', () => ({
  assessShadowDetection: h.assess,
  replayAbuseAssessments: h.replay,
  loadAbuseAssessmentSettings: h.loadSettings,
  summarizeDetection: h.summarize,
}));
vi.mock('@server/security/abuseAssessment/linkedAccountEvidence', () => ({
  linkedAccountGroupEvidence: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.record,
}));

const loadRoutes = async () => {
  h.current = 'assessments';
  await import('@pages/api/admin/shadow-detections/assessments');
  h.current = 'replay';
  await import('@pages/api/admin/shadow-detections/assessment-replay');
};

const ADMIN_ID = 'a'.repeat(24);
const DETECTION_ID = 'b'.repeat(24);
const OTHER_DETECTION_ID = 'c'.repeat(24);
const ASSESSMENT_ID = 'd'.repeat(24);

const request = (method: 'GET' | 'POST', options: { body?: unknown; query?: Record<string, string> } = {}) => {
  const { req, res } = createMocks({ method, body: options.body, query: options.query });
  Object.assign(req, { user: { id: ADMIN_ID, isAdmin: true }, logger: { error: vi.fn() } });
  return { req, res };
};

const assessment = (overrides: Partial<AbuseAssessmentItem> = {}): AbuseAssessmentItem => ({
  id: ASSESSMENT_ID,
  detectionId: DETECTION_ID,
  result: 'abuse',
  probabilities: [{ value: 'abuse', probability: 0.9 }],
  confidence: 0.9,
  model: 'test-decisions',
  modelVersion: null,
  policyVersion: 1,
  evidenceVersion: RISK_EVIDENCE_VERSION,
  evidenceHash: 'hash',
  featureSummary: {
    evidenceVersion: RISK_EVIDENCE_VERSION,
    detection: {
      detector: 'signupNetworkBurst',
      detectorPolicyVersion: 1,
      windowMinutes: 180,
      hostingNetwork: true,
      signals: [{ key: 'ipSignups', observed: 3, threshold: 1 }],
    },
    accounts: [],
    accountsOmitted: 0,
    group: null,
  },
  failure: null,
  attempts: 1,
  costUsd: 0.001,
  trigger: 'admin',
  requestedBy: ADMIN_ID,
  assessedAt: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

const detection = (overrides: Partial<ShadowDetectionItem> = {}): ShadowDetectionItem => ({
  id: DETECTION_ID,
  detector: 'signupNetworkBurst',
  policyVersion: 1,
  wouldAction: 'contain',
  summary: '3 self-serve signups from one IP in 180 minutes',
  userIds: ['u1'],
  network: { ip: '203.0.113.7', asn: 64500, asnOrg: null, country: 'US', hosting: true },
  signals: [{ key: 'ipSignups', label: 'Self-serve signups from this IP', observed: 3, threshold: 1 }],
  windowMinutes: 180,
  detectedAt: new Date('2026-10-01T00:00:00Z'),
  verdict: null,
  verdicts: [],
  revision: 0,
  ...overrides,
});

beforeEach(async () => {
  h.listForDetection.mockReset().mockResolvedValue([]);
  h.findById.mockReset().mockResolvedValue(null);
  h.assess.mockReset();
  h.replay.mockReset().mockResolvedValue({ status: 'completed', reason: null, rows: [] });
  h.loadSettings.mockReset().mockResolvedValue({ enabled: true, config: { model: null } });
  h.summarize.mockReset().mockResolvedValue({ summarized: true });
  h.record.mockReset().mockResolvedValue(null);
  if (!h.handlers.assessments) await loadRoutes();
});

describe('GET /api/admin/shadow-detections/assessments', () => {
  it('is session-only, readable with support:read and runnable only with users:moderate', () => {
    expect(h.routeOptions).toHaveBeenCalledWith({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: 'support:read', POST: 'users:moderate' },
    });
  });

  it('rejects an invalid detection id', async () => {
    const { req, res } = request('GET', { query: { detectionId: 'not-an-id' } });
    await expect(h.handlers.assessments.get(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(h.listForDetection).not.toHaveBeenCalled();
  });

  it('lists the detection assessments and responds with { data }', async () => {
    h.listForDetection.mockResolvedValue([assessment()]);
    const { req, res } = request('GET', { query: { detectionId: DETECTION_ID } });

    await h.handlers.assessments.get(req, res);

    expect(h.listForDetection).toHaveBeenCalledWith(DETECTION_ID);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()['cache-control']).toBe('private, no-store');
    expect(res._getJSONData()).toMatchObject({ data: [{ id: ASSESSMENT_ID, detectionId: DETECTION_ID }] });
  });

  it('still lists rows made under an older evidence version or a model since dropped from the catalog', async () => {
    const legacy = {
      ...assessment(),
      model: 'retired-model',
      evidenceVersion: 0,
      featureSummary: { evidenceVersion: 0, detection: { detector: 'retiredDetector' }, accounts: [] },
    } as unknown as AbuseAssessmentItem;
    h.listForDetection.mockResolvedValue([legacy]);
    const { req, res } = request('GET', { query: { detectionId: DETECTION_ID } });

    await h.handlers.assessments.get(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      data: [{ model: 'retired-model', featureSummary: { evidenceVersion: 0 } }],
    });
  });
});

describe('POST /api/admin/shadow-detections/assessments', () => {
  it('rejects an invalid body without assessing', async () => {
    for (const body of [{}, { detectionId: 'nope' }]) {
      const { req, res } = request('POST', { body });
      await expect(h.handlers.assessments.post(req, res)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(h.assess).not.toHaveBeenCalled();
  });

  it('assesses as an admin trigger on behalf of the signed-in admin', async () => {
    h.assess.mockResolvedValue({ status: 'skipped', reason: 'disabled' });
    const { req, res } = request('POST', { body: { detectionId: DETECTION_ID } });

    await h.handlers.assessments.post(req, res);

    expect(h.assess).toHaveBeenCalledWith({
      detectionId: DETECTION_ID,
      trigger: 'admin',
      requestedBy: ADMIN_ID,
      logger: (req as unknown as { logger: unknown }).logger,
      deps: { groupEvidence: expect.any(Function) },
    });
  });

  it('audits a fresh assessment and returns the outcome', async () => {
    h.assess.mockResolvedValue({ status: 'assessed', cached: false, item: assessment() });
    const { req, res } = request('POST', { body: { detectionId: DETECTION_ID } });

    await h.handlers.assessments.post(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ status: 'assessed', cached: false, item: { id: ASSESSMENT_ID } });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'security.detection.assessed',
        target: expect.objectContaining({ kind: 'system', id: DETECTION_ID }),
        details: expect.objectContaining({
          detectionId: DETECTION_ID,
          assessmentId: ASSESSMENT_ID,
          model: 'test-decisions',
          result: 'abuse',
        }),
      })
    );
  });

  it('writes no audit entry for a cached outcome', async () => {
    h.assess.mockResolvedValue({ status: 'assessed', cached: true, item: assessment() });
    const { req, res } = request('POST', { body: { detectionId: DETECTION_ID } });

    await h.handlers.assessments.post(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(h.record).not.toHaveBeenCalled();
  });

  it('writes no audit entry for a skipped outcome', async () => {
    h.assess.mockResolvedValue({ status: 'skipped', reason: 'budget_exhausted' });
    const { req, res } = request('POST', { body: { detectionId: DETECTION_ID } });

    await h.handlers.assessments.post(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ status: 'skipped', reason: 'budget_exhausted' });
    expect(h.record).not.toHaveBeenCalled();
  });

  it('still answers 200 with the outcome when the audit write throws, and logs it', async () => {
    h.assess.mockResolvedValue({ status: 'assessed', cached: false, item: assessment() });
    h.record.mockRejectedValue(new Error('actor lookup failed'));
    const { req, res } = request('POST', { body: { detectionId: DETECTION_ID } });

    await h.handlers.assessments.post(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ status: 'assessed', item: { id: ASSESSMENT_ID } });
    expect((req as unknown as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalledWith(
      expect.stringContaining(ASSESSMENT_ID),
      expect.any(Error)
    );
  });
});

describe('POST /api/admin/shadow-detections/assessment-replay', () => {
  it('is session-only and gated on the moderation permission', () => {
    expect(h.routeOptions).toHaveBeenCalledWith({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { POST: 'users:moderate' },
    });
  });

  it.each([
    ['no detection ids', { detectionIds: [], models: ['test-decisions'] }],
    ['no models', { detectionIds: [DETECTION_ID], models: [] }],
    [
      'more than three models',
      { detectionIds: [DETECTION_ID], models: ['test-decisions', 'gpt-6-luna', 'jev-1.13.0', 'jev-latest'] },
    ],
    ['an unknown model', { detectionIds: [DETECTION_ID], models: ['gpt-9'] }],
    ['a malformed detection id', { detectionIds: ['nope'], models: ['test-decisions'] }],
  ])('rejects %s', async (_label, body) => {
    const { req, res } = request('POST', { body });
    await expect(h.handlers.replay.post(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(h.replay).not.toHaveBeenCalled();
  });

  it('replays found detections labeled by their verdict, with a deadline, and reports missing ids', async () => {
    h.findById.mockImplementation(async (id: string) =>
      id === DETECTION_ID ? detection({ verdict: 'confirmed_abuse' }) : null
    );
    h.replay.mockResolvedValue({ status: 'completed', reason: null, rows: [] });
    const { req, res } = request('POST', {
      body: { detectionIds: [DETECTION_ID, OTHER_DETECTION_ID, DETECTION_ID], models: ['test-decisions'] },
    });

    await h.handlers.replay.post(req, res);

    expect(h.findById).toHaveBeenCalledTimes(2);
    expect(h.replay).toHaveBeenCalledWith({
      examples: [{ id: DETECTION_ID, label: 'confirmed_abuse', summary: { summarized: true } }],
      models: ['test-decisions'],
      logger: (req as unknown as { logger: unknown }).logger,
      deadline: expect.any(Number),
      settings: { enabled: true, config: { model: null } },
    });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ status: 'completed', reason: null, rows: [], missing: [OTHER_DETECTION_ID] });
  });

  it('reports a self-assessed detection as missing and never replays it', async () => {
    h.findById.mockResolvedValue(detection({ detector: 'signupDomainHold' }));
    const { req, res } = request('POST', { body: { detectionIds: [DETECTION_ID], models: ['test-decisions'] } });

    await h.handlers.replay.post(req, res);

    expect(h.replay).toHaveBeenCalledWith(expect.objectContaining({ examples: [] }));
    expect(res._getJSONData()).toMatchObject({ missing: [DETECTION_ID] });
  });

  it('labels an ungraded detection null', async () => {
    h.findById.mockResolvedValue(detection({ verdict: null }));
    const { req, res } = request('POST', { body: { detectionIds: [DETECTION_ID], models: ['jev-latest'] } });

    await h.handlers.replay.post(req, res);

    expect(h.replay).toHaveBeenCalledWith(
      expect.objectContaining({ examples: [expect.objectContaining({ id: DETECTION_ID, label: null })] })
    );
  });

  it('answers stopped/disabled without reading any detection when the feature is off', async () => {
    h.loadSettings.mockResolvedValue({ enabled: false, config: { model: null } });
    const { req, res } = request('POST', { body: { detectionIds: [DETECTION_ID], models: ['test-decisions'] } });

    await h.handlers.replay.post(req, res);

    expect(res._getJSONData()).toEqual({ status: 'stopped', reason: 'disabled', rows: [], missing: [] });
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.replay).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('passes a no_model stop through with the missing ids and writes no audit entry', async () => {
    h.findById.mockResolvedValue(detection());
    h.replay.mockResolvedValue({ status: 'stopped', reason: 'no_model', rows: [] });
    const { req, res } = request('POST', {
      body: { detectionIds: [DETECTION_ID, OTHER_DETECTION_ID], models: ['test-decisions'] },
    });

    await h.handlers.replay.post(req, res);

    expect(res._getJSONData()).toEqual({ status: 'stopped', reason: 'no_model', rows: [], missing: [] });
    expect(h.record).not.toHaveBeenCalled();
  });

  it('audits a replay that returned rows', async () => {
    h.findById.mockResolvedValue(detection());
    h.replay.mockResolvedValue({
      status: 'completed',
      reason: null,
      rows: [
        {
          exampleId: DETECTION_ID,
          label: null,
          model: 'test-decisions',
          result: 'abuse',
          probabilities: [],
          confidence: 0.9,
          failure: null,
        },
      ],
    });
    const { req, res } = request('POST', { body: { detectionIds: [DETECTION_ID], models: ['test-decisions'] } });

    await h.handlers.replay.post(req, res);

    expect(h.record).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'security.detection.replayed',
        details: { detectionIds: [DETECTION_ID], models: ['test-decisions'], rows: 1 },
      })
    );
  });

  it('writes no audit entry when a replay returned no rows', async () => {
    h.findById.mockResolvedValue(detection());
    const { req, res } = request('POST', { body: { detectionIds: [DETECTION_ID], models: ['test-decisions'] } });

    await h.handlers.replay.post(req, res);

    expect(h.record).not.toHaveBeenCalled();
  });
});
