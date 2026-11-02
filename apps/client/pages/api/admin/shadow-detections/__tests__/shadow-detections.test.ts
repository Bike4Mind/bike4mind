import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, SHADOW_DETECTION_LIST_LIMIT, type ShadowDetectionItem } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Record<string, (req: unknown, res: unknown) => Promise<void>>>,
  current: '',
  baseOptions: vi.fn(),
  list: vi.fn(),
  summarize: vi.fn(),
  addVerdict: vi.fn(),
  record: vi.fn(),
  userWrite: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseOptions(options);
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
  shadowDetectionRepository: { list: h.list, summarize: h.summarize, addVerdict: h.addVerdict },
  // Grading must never act on the accounts a detection names: any write here fails the test.
  userRepository: { update: h.userWrite, updateOne: h.userWrite, setRiskReviewState: h.userWrite },
  userApiKeyRepository: { update: h.userWrite },
}));
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.record,
}));

const loadRoutes = async () => {
  h.current = 'list';
  await import('@pages/api/admin/shadow-detections/index');
  h.current = 'verdict';
  await import('@pages/api/admin/shadow-detections/verdict');
};

const ADMIN_ID = 'a'.repeat(24);
const DETECTION_ID = 'b'.repeat(24);
const REASON = 'Same cohort as last week';

const request = (method: 'GET' | 'POST', options: { body?: unknown; query?: Record<string, string> } = {}) => {
  const { req, res } = createMocks({ method, body: options.body, query: options.query });
  Object.assign(req, { user: { id: ADMIN_ID, isAdmin: true }, logger: { error: vi.fn() } });
  return { req, res };
};

const nonAdminRequest = (method: 'GET' | 'POST', body?: unknown) => {
  const { req, res } = createMocks({ method, body });
  Object.assign(req, { user: { id: ADMIN_ID, isAdmin: false }, logger: {} });
  return { req, res };
};

const item = (overrides: Partial<ShadowDetectionItem> = {}): ShadowDetectionItem => ({
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

const verdictBody = (overrides: Record<string, unknown> = {}) => ({
  id: DETECTION_ID,
  expectedRevision: 0,
  verdict: 'confirmed_abuse',
  reason: REASON,
  ...overrides,
});

beforeEach(async () => {
  h.list.mockReset().mockResolvedValue({ data: [], truncated: false });
  h.summarize.mockReset().mockResolvedValue([]);
  h.addVerdict.mockReset();
  h.record.mockReset().mockResolvedValue(null);
  h.userWrite.mockReset();
  if (!h.handlers.list) await loadRoutes();
});

describe('GET /api/admin/shadow-detections', () => {
  it('is session-only and admin-only', async () => {
    expect(h.baseOptions).toHaveBeenCalledWith({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] });
    const { req, res } = nonAdminRequest('GET');
    await expect(h.handlers.list.get(req, res)).rejects.toThrow(/admin access required/i);
    expect(h.list).not.toHaveBeenCalled();
  });

  it('passes the filters through and returns the list with its summary', async () => {
    const summary = [
      {
        detector: 'signupNetworkBurst',
        policyVersion: 1,
        recorded: 4,
        confirmedAbuse: 1,
        legitimateHuman: 1,
        legitimateAutomation: 0,
        insufficientEvidence: 0,
      },
    ];
    h.list.mockResolvedValue({ data: [item()], truncated: true });
    h.summarize.mockResolvedValue(summary);
    const { req, res } = request('GET', { query: { detector: 'signupNetworkBurst', verdict: 'unreviewed' } });

    await h.handlers.list.get(req, res);

    expect(h.list).toHaveBeenCalledWith({
      detector: 'signupNetworkBurst',
      verdict: 'unreviewed',
      limit: SHADOW_DETECTION_LIST_LIMIT,
    });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()['cache-control']).toBe('private, no-store');
    const body = res._getJSONData();
    expect(body).toMatchObject({ truncated: true, summary, data: [{ id: DETECTION_ID, revision: 0 }] });
  });

  it('rejects an unknown filter', async () => {
    const { req, res } = request('GET', { query: { verdict: 'maybe' } });
    await expect(h.handlers.list.get(req, res)).rejects.toThrow(/unknown detector or verdict/i);
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/shadow-detections/verdict', () => {
  it('is session-only and admin-only', async () => {
    const { req, res } = nonAdminRequest('POST', verdictBody());
    await expect(h.handlers.verdict.post(req, res)).rejects.toThrow(/admin access required/i);
    expect(h.addVerdict).not.toHaveBeenCalled();
  });

  it('records the verdict as the signed-in admin, audits it and returns the updated record', async () => {
    const graded = item({
      verdict: 'confirmed_abuse',
      revision: 1,
      verdicts: [{ verdict: 'confirmed_abuse', reason: REASON, reviewerId: ADMIN_ID, reviewedAt: new Date() }],
    });
    h.addVerdict.mockResolvedValue({ status: 'updated', item: graded });
    const { req, res } = request('POST', { body: verdictBody() });

    await h.handlers.verdict.post(req, res);

    expect(h.addVerdict).toHaveBeenCalledWith({
      id: DETECTION_ID,
      expectedRevision: 0,
      verdict: 'confirmed_abuse',
      reason: REASON,
      reviewerId: ADMIN_ID,
    });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: DETECTION_ID, verdict: 'confirmed_abuse', revision: 1 });
    expect(h.record).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'security.detection.reviewed',
        target: expect.objectContaining({ kind: 'system', id: DETECTION_ID }),
        reason: REASON,
        details: expect.objectContaining({ detectionId: DETECTION_ID, verdict: 'confirmed_abuse', userIds: ['u1'] }),
      })
    );
    expect(h.userWrite).not.toHaveBeenCalled();
  });

  it('still answers 200 with the saved verdict when the audit write throws, and logs it', async () => {
    h.addVerdict.mockResolvedValue({ status: 'updated', item: item({ verdict: 'confirmed_abuse', revision: 1 }) });
    h.record.mockRejectedValue(new Error('actor lookup failed'));
    const { req, res } = request('POST', { body: verdictBody() });

    await h.handlers.verdict.post(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: DETECTION_ID, verdict: 'confirmed_abuse', revision: 1 });
    expect((req as unknown as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalledWith(
      expect.stringContaining(DETECTION_ID),
      expect.any(Error)
    );
  });

  it('answers a stale revision with 409 and the current record, without auditing', async () => {
    h.addVerdict.mockResolvedValue({ status: 'conflict', item: item({ verdict: 'legitimate_human', revision: 1 }) });
    const { req, res } = request('POST', { body: verdictBody() });

    await h.handlers.verdict.post(req, res);

    expect(res._getStatusCode()).toBe(409);
    const body = res._getJSONData();
    expect(body.error).toEqual(expect.any(String));
    expect(body.item).toMatchObject({ id: DETECTION_ID, verdict: 'legitimate_human', revision: 1 });
    expect(h.record).not.toHaveBeenCalled();
  });

  it('answers a missing detection with 404', async () => {
    h.addVerdict.mockResolvedValue({ status: 'not_found' });
    const { req, res } = request('POST', { body: verdictBody() });
    await expect(h.handlers.verdict.post(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(h.record).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing reason', { reason: undefined }],
    ['a too-short reason', { reason: 'x' }],
  ])('rejects %s before grading', async (_label, overrides) => {
    const { req, res } = request('POST', { body: verdictBody(overrides) });
    await expect(h.handlers.verdict.post(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(h.addVerdict).not.toHaveBeenCalled();
  });

  it('rejects an invalid verdict or id', async () => {
    for (const overrides of [{ verdict: 'guilty' }, { id: 'not-an-id' }, { expectedRevision: -1 }]) {
      const { req, res } = request('POST', { body: verdictBody(overrides) });
      await expect(h.handlers.verdict.post(req, res)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(h.addVerdict).not.toHaveBeenCalled();
  });
});
