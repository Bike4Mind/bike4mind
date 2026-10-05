import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindById, mockGet } = vi.hoisted(() => ({ mockFindById: vi.fn(), mockGet: vi.fn() }));

// baseApi is stubbed (no auth chain); the route's own path-token check is what is under test.
vi.mock('@server/middlewares/baseApi', () => import('@server/qa/testing/baseApiStub'));
vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));
vi.mock('@bike4mind/database', () => ({
  QaRun: { findById: (...a: unknown[]) => mockFindById(...a) },
}));
vi.mock('@server/utils/storage', () => ({
  getQaArtifactsStorage: () => ({ getContentAsBuffer: (...a: unknown[]) => mockGet(...a) }),
}));

import handler, { config } from '../[runId]/[token]/[...path]';
import { signQaReportToken } from '@server/qa/reportToken';

const RUN_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const RUN_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const call = async (query: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { logger });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

beforeEach(() => {
  mockFindById.mockReset().mockReturnValue({
    select: () => ({ lean: async () => ({ reportPrefix: 'product-a/100-1/report/' }) }),
  });
  mockGet.mockReset().mockResolvedValue(Buffer.from('<html></html>'));
});

describe('GET /api/admin/qa/report/[runId]/[token]/[...path]', () => {
  it('serves index.html sandboxed, with no cookie', async () => {
    const res = await call({ runId: RUN_A, token: signQaReportToken(RUN_A), path: ['index.html'] });
    expect(res._getStatusCode()).toBe(200);
    expect(mockGet).toHaveBeenCalledWith('product-a/100-1/report/index.html');
    expect(res.getHeader('Content-Type')).toBe('text/html');
    expect(res.getHeader('Content-Security-Policy')).toBe('sandbox allow-scripts allow-popups allow-downloads');
    expect(res.getHeader('Referrer-Policy')).toBe('no-referrer');
    expect(res.getHeader('Set-Cookie')).toBeUndefined();
  });

  it('serves a relative asset with the token taken from the path', async () => {
    const res = await call({ runId: RUN_A, token: signQaReportToken(RUN_A), path: ['data', 'a.png'] });
    expect(res._getStatusCode()).toBe(200);
    expect(mockGet).toHaveBeenCalledWith('product-a/100-1/report/data/a.png');
    expect(res.getHeader('Content-Type')).toBe('image/png');
  });

  it('rejects a token minted for another run', async () => {
    const res = await call({ runId: RUN_B, token: signQaReportToken(RUN_A), path: ['index.html'] });
    expect(res._getStatusCode()).toBe(401);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('rejects path traversal', async () => {
    const res = await call({
      runId: RUN_A,
      token: signQaReportToken(RUN_A),
      path: ['..', '..', '200-1', 'report', 'index.html'],
    });
    expect(res._getStatusCode()).toBe(404);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('401s a missing or invalid token', async () => {
    expect((await call({ runId: RUN_A, path: ['index.html'] }))._getStatusCode()).toBe(401);
    expect((await call({ runId: RUN_A, token: 'nope', path: ['index.html'] }))._getStatusCode()).toBe(401);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('404s a malformed run id and a missing object', async () => {
    expect((await call({ runId: 'x', token: 't', path: ['index.html'] }))._getStatusCode()).toBe(404);
    mockGet.mockRejectedValueOnce(new Error('NoSuchKey'));
    expect((await call({ runId: RUN_A, token: signQaReportToken(RUN_A), path: ['index.html'] }))._getStatusCode()).toBe(
      404
    );
  });

  it('streams reports past the default response limit', () => {
    expect(config.api.responseLimit).toBe(false);
  });
});
