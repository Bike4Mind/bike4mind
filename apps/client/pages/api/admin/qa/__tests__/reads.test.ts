import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { reads } = vi.hoisted(() => ({
  reads: {
    getQaFacets: vi.fn(),
    getQaOverview: vi.fn(),
    listQaRuns: vi.fn(),
    getQaRunDetail: vi.fn(),
    getQaTestHistory: vi.fn(),
  },
}));

// baseApi is stubbed (no auth chain) but runs the .use() middlewares, so the real adminApi gate is under test.
vi.mock('@server/middlewares/baseApi', async () => {
  const { default: errorHandler } = await import('@server/middlewares/errorHandler');
  type Step = (req: unknown, res: unknown, next: () => void) => unknown;
  return {
    baseApi: () => {
      const gates: Step[] = [];
      const chain = {
        use: (gate: Step) => (gates.push(gate), chain),
        get: (handler: Step) => async (req: never, res: never) => {
          try {
            for (const gate of gates) await gate(req, res, () => undefined);
            await handler(req, res, () => undefined);
          } catch (error) {
            errorHandler(error as Error, req, res);
          }
        },
      };
      return chain;
    },
  };
});
vi.mock('@server/qa/reads', () => reads);
vi.mock('@server/qa/storage', () => ({ qaMediaStorage: () => ({ exists: vi.fn(), signedGetUrl: vi.fn() }) }));
vi.mock('@server/qa/reportToken', () => ({ signQaReportToken: (id: string) => `tok-${id}` }));

import facets from '../facets';
import overview from '../overview';
import runs from '../runs/index';
import runDetail from '../runs/[id]';
import tests from '../tests';

type Route = (req: unknown, res: unknown) => Promise<void>;
const ADMIN = { id: 'admin1', isAdmin: true };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const call = async (route: unknown, query: Record<string, unknown>, user: unknown = ADMIN) => {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger });
  await (route as Route)(req, res);
  return { status: res._getStatusCode(), json: res._getJSONData() };
};

beforeEach(() => {
  for (const fn of Object.values(reads)) fn.mockReset().mockResolvedValue({ ok: true });
});

describe('admin QA read routes', () => {
  it('403s a non-admin on every route', async () => {
    for (const route of [facets, overview, runs, runDetail, tests]) {
      const query = { product: 'product-a', id: 'a'.repeat(24), testKey: 'k' };
      const response = await call(route, query, { id: 'u', isAdmin: false });
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.json)).toMatch(/missing permission/i);
    }
    for (const fn of Object.values(reads)) expect(fn).not.toHaveBeenCalled();
  });

  it('passes parsed filters to the overview', async () => {
    const { status } = await call(overview, { product: 'product-a', env: 'staging', range: '30d' });
    expect(status).toBe(200);
    expect(reads.getQaOverview).toHaveBeenCalledWith({
      product: 'product-a',
      env: 'staging',
      branch: 'main',
      rangeDays: 30,
    });
  });

  it('422s the overview without a product', async () => {
    expect((await call(overview, {})).status).toBe(422);
  });

  it('passes the before cursor to the run list and 400s a bad one', async () => {
    await call(runs, { product: 'product-a', before: '2026-09-28T09:00:00.000Z' });
    expect(reads.listQaRuns).toHaveBeenCalledWith(expect.objectContaining({ product: 'product-a' }), {
      before: new Date('2026-09-28T09:00:00.000Z'),
    });
    expect((await call(runs, { product: 'product-a', before: 'yesterday' })).status).toBe(400);
  });

  it('404s a malformed run id without querying, and an unknown run', async () => {
    expect((await call(runDetail, { id: 'not-an-id' })).status).toBe(404);
    expect(reads.getQaRunDetail).not.toHaveBeenCalled();
    reads.getQaRunDetail.mockResolvedValueOnce(null);
    expect((await call(runDetail, { id: 'a'.repeat(24) })).status).toBe(404);
  });

  it('wires storage and the report token into run detail', async () => {
    await call(runDetail, { id: 'a'.repeat(24) });
    const deps = reads.getQaRunDetail.mock.calls[0][1];
    expect(deps.signReportToken('r1')).toBe('tok-r1');
  });

  it('reads a test key with spaces, > and / verbatim', async () => {
    const testKey = 'e2e/notebook.spec.ts > Notebook > saves ?#';
    await call(tests, { testKey });
    expect(reads.getQaTestHistory).toHaveBeenCalledWith(testKey);
    expect((await call(tests, {})).status).toBe(400);
  });

  it('scopes facets to a valid product only', async () => {
    await call(facets, { product: 'Not A Slug' });
    expect(reads.getQaFacets).toHaveBeenCalledWith(undefined);
  });
});
