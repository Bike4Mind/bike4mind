import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

/**
 * POST /api/users/report generates the platform-wide daily activity report (every user's
 * email plus per-feature usage). It shipped behind a bare `baseApi()` - authentication only -
 * while its sibling users/counterLogs.ts, reading the same CounterLog data, carries both an
 * ADMIN scope gate and an ability check. This pins that the two now match.
 */

// `any` below is deliberate test-mock plumbing, matching the repo's handler-test convention.
const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  baseApiOptions: undefined as any,
  reportGenerated: false,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return {
    baseApi: (options?: any) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});

vi.mock('@bike4mind/database', () => ({ CounterLog: class CounterLog {} }));
vi.mock('@bike4mind/services', () => ({
  counterService: {
    generateDailyReport: async () => {
      mockRefs.reportGenerated = true;
      return { rows: [] };
    },
  },
}));

import '@pages/api/users/report';

function mocks(can: boolean) {
  const { req, res } = createMocks({ method: 'POST', query: { date: '2026-09-01' } });
  (req as any).ability = { can: () => can };
  (req as any).logger = { error: vi.fn(), info: vi.fn() };
  return { req, res };
}

describe('POST /api/users/report - admin gate', () => {
  beforeEach(() => {
    mockRefs.reportGenerated = false;
  });

  it('declares the ADMIN scope gate, so a narrow API key stays narrow', () => {
    expect(mockRefs.baseApiOptions?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects a caller without read on CounterLog before generating anything', async () => {
    const { req, res } = mocks(false);
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/unauthorized/i);
    expect(mockRefs.reportGenerated).toBe(false);
  });

  it('generates the report for a caller that can read CounterLog', async () => {
    const { req, res } = mocks(true);
    await mockRefs.postHandler!(req, res);
    expect(mockRefs.reportGenerated).toBe(true);
    expect(res._getStatusCode()).toBe(200);
  });
});
