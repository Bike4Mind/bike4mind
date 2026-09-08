import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The generate gate's 400-vs-200 decision, which the severity split feeds.
 *
 * A BLOCKING spec error (e.g. duplicate order) must 400 and never reach generation; an
 * ADVISORY one (an unmapped roster role key) must NOT block - the digest generates and the
 * advisory rides along in the 200 body. This pins that contract at the handler, where the
 * decision actually lives, so a regression that routed a structural error to the advisory
 * list would fail here.
 */

const { mockLoadConfig, mockGenerateReport } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockGenerateReport: vi.fn(),
}));

// Strip the middleware chain (DB connect, auth, logging) so the test exercises the route
// body directly, matching the other pages/api suites.
vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: unknown) => handler;
    return chain;
  },
}));
vi.mock('@server/services/prReport/context', () => ({
  loadPrReportConfig: (...a: unknown[]) => mockLoadConfig(...a),
  createGenerateDeps: () => ({}),
}));
vi.mock('@server/services/prReport/guards', () => ({
  assertRepoFormat: () => {},
}));
vi.mock('@bike4mind/services', () => ({
  prReportService: { generateReport: (...a: unknown[]) => mockGenerateReport(...a) },
}));

import handler from '../generate';

const BLOCKING = {
  bucket: 'awaitingReview',
  reason: 'order 130 is already used by "reviewOngoing" - precedence would be ambiguous',
  severity: 'blocking' as const,
};
const ADVISORY = {
  bucket: 'awaitingReview',
  reason:
    'roleKey "reviewer_" has no entry in the identity map - the roster will post without an @-mention until you add it',
  severity: 'advisory' as const,
};

function makeReqRes() {
  const { req, res } = createMocks({ method: 'POST' });
  (req as unknown as { user: unknown }).user = { isAdmin: true };
  (req as unknown as { logger: unknown }).logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { req, res };
}

const baseConfig = {
  repo: 'owner/repo',
  identityLookup: {},
  bucketSpecs: {},
  identityMapErrors: [],
};

beforeEach(() => {
  mockLoadConfig.mockReset();
  mockGenerateReport.mockReset();
});

// The mocked baseApi returns the raw handler, so the middleware's error-to-HTTP mapping is
// absent - a thrown BadRequestError surfaces as a rejection rather than a 400 body. That is
// the observable behavior of the gate.
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('POST /api/admin/pr-report/generate - severity gate', () => {
  it('blocks generation on a structural (blocking) spec error', async () => {
    mockLoadConfig.mockResolvedValue({ ...baseConfig, specErrors: [BLOCKING], rosterWarnings: [] });
    const { req, res } = makeReqRes();

    await expect(run(req, res)).rejects.toThrow(/Bucket configuration is invalid/);
    expect(mockGenerateReport).not.toHaveBeenCalled();
  });

  it('does NOT block on an advisory (unmapped roleKey) and rides it along in the 200 body', async () => {
    mockLoadConfig.mockResolvedValue({ ...baseConfig, specErrors: [], rosterWarnings: [ADVISORY] });
    mockGenerateReport.mockResolvedValue({
      ok: true,
      response: {
        text: 'digest',
        prCount: 3,
        warnings: { approvalDataUnavailable: false, openPrListTruncated: false },
        mentionNames: {},
        mentionNamesUnavailable: false,
      },
    });
    const { req, res } = makeReqRes();

    await run(req, res);

    expect(mockGenerateReport).toHaveBeenCalledOnce();
    expect((res as unknown as { _getStatusCode: () => number })._getStatusCode()).toBe(200);
    const body = (res as unknown as { _getJSONData: () => Record<string, unknown> })._getJSONData();
    expect(body.text).toBe('digest');
    expect(body.rosterWarnings).toHaveLength(1);
    // The blocking list is never echoed to the client.
    expect(body.specErrors).toBeUndefined();
  });
});
