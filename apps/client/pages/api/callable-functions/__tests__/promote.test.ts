// @vitest-environment node
/**
 * POST [id]/promote, PUT [id]/examples, and GET [id]/calls through the real `baseApi` chain and error handler, plus
 * a sweep of every callable-function route that takes a body. The services' own rules are in
 * packages/server-utils/src/callableFunctions/promote.test.ts and registry.e2e.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { ConflictError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  enabled: true,
  noUser: false,
  perUserBuckets: [] as string[],
  validateApiKey: vi.fn(),
  promoteCallableFunction: vi.fn(),
  setCallableFunctionExamples: vi.fn(),
  summarizeCallableFunctionCalls: vi.fn(),
  createCallableFunction: vi.fn(),
  repinCallableFunction: vi.fn(),
  setCallableFunctionEnabled: vi.fn(),
  runCallableFunctionTests: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/callableFunctions/promote', () => ({
  promoteCallableFunction: h.promoteCallableFunction,
}));
vi.mock('@bike4mind/server-utils/callableFunctions/testRun', () => ({
  runCallableFunctionTests: h.runCallableFunctionTests,
  callableFunctionTestRunBudget: () => 45_000,
}));
vi.mock('@bike4mind/server-utils/callableFunctions/registry', () => ({
  setCallableFunctionExamples: h.setCallableFunctionExamples,
  summarizeCallableFunctionCalls: h.summarizeCallableFunctionCalls,
  createCallableFunction: h.createCallableFunction,
  listCallableFunctions: vi.fn(),
  repinCallableFunction: h.repinCallableFunction,
  setCallableFunctionEnabled: h.setCallableFunctionEnabled,
  getCallableFunction: vi.fn(),
  deleteCallableFunction: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/callableFunctions/access', async () => {
  const { ForbiddenError } = await import('@bike4mind/common');
  return {
    resolveCallableFunctionsEnabled: vi.fn(async () => h.enabled),
    assertCallableFunctionsEnabled: vi.fn(async () => {
      if (!h.enabled) throw new ForbiddenError('Callable functions are disabled');
    }),
  };
});
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: (bucket: string) => {
    h.perUserBuckets.push(bucket);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...args: unknown[]) => h.validateApiKey(...args),
    },
  };
});
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    auth: (
      req: { headers?: Record<string, unknown>; user?: unknown },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void
    ) => {
      if (!req.headers?.authorization) return res.status(401).json({ error: 'Unauthorized' });
      if (!req.user && !h.noUser) req.user = JWT_USER;
      next();
    },
  };
});

import collectionRoute from '../index';
import functionRoute from '../[id]/index';
import pinRoute from '../[id]/pin';
import testRunRoute from '../[id]/test-run';
import promoteRoute from '../[id]/promote';
import examplesRoute from '../[id]/examples';
import callsRoute from '../[id]/calls';

const FUNCTION_ID = '6650f0a1b2c3d4e5f6a7b8c9';
type Route = (req: unknown, res: unknown) => Promise<unknown>;

async function fire(
  route: unknown,
  { method = 'POST', body = {} as unknown } = {},
  headers: Record<string, string> = { authorization: 'Bearer live-jwt' }
) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>(
    {
      method: method as 'POST',
      url: `/api/callable-functions/${FUNCTION_ID}`,
      query: { id: FUNCTION_ID },
      body: body as never,
      headers: { 'content-type': 'application/json', ...headers },
    },
    { eventEmitter: EventEmitter }
  );
  await (route as Route)(req, res);
  return res;
}

const EXAMPLE = {
  name: 'handbook case',
  input: { span: 3 },
  expected: { deflection: 6 },
  tolerance: { rel: 1e-9 },
  citation: 'https://data.example.com/beams/table-3',
};
const PROMOTION = { function: { id: FUNCTION_ID, state: 'live', trustLabel: 'verified' }, run: { passed: 2 } };

beforeEach(() => {
  h.enabled = true;
  h.noUser = false;
  for (const mock of [
    h.validateApiKey,
    h.promoteCallableFunction,
    h.setCallableFunctionExamples,
    h.summarizeCallableFunctionCalls,
    h.createCallableFunction,
    h.repinCallableFunction,
    h.setCallableFunctionEnabled,
    h.runCallableFunctionTests,
  ]) {
    mock.mockReset();
  }
  h.promoteCallableFunction.mockResolvedValue(PROMOTION);
  h.setCallableFunctionExamples.mockResolvedValue({ id: FUNCTION_ID, examples: [EXAMPLE] });
  h.summarizeCallableFunctionCalls.mockResolvedValue({ total: 0, outcomes: {}, recent: [] });
});

it('gives each new route its own per-user rate limit bucket', () => {
  expect(h.perUserBuckets).toEqual(
    expect.arrayContaining([
      'POST /api/callable-functions/[id]/promote',
      'PUT /api/callable-functions/[id]/examples',
      'GET /api/callable-functions/[id]/calls',
    ])
  );
});

describe('POST /api/callable-functions/[id]/promote', () => {
  it('promotes for the signed-in owner and returns the function and the run', async () => {
    const res = await fire(promoteRoute);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(PROMOTION);
    expect(h.promoteCallableFunction).toHaveBeenCalledWith(expect.objectContaining({ id: 'jwt-user' }), FUNCTION_ID, {
      budgetMs: 45_000,
    });
  });

  it('answers 401 without a session or a user, and for an API key without looking it up', async () => {
    expect((await fire(promoteRoute, {}, {}))._getStatusCode()).toBe(401);
    const keyed = await fire(promoteRoute, {}, { 'x-api-key': 'b4m_live_0123456789abcdef0123456789abcdef' });
    expect(keyed._getStatusCode()).toBe(401);
    expect(h.validateApiKey).not.toHaveBeenCalled();
    h.noUser = true;
    expect((await fire(promoteRoute))._getStatusCode()).toBe(401);
    expect(h.promoteCallableFunction).not.toHaveBeenCalled();
  });

  it('answers 403 with the setting off and promotes nothing', async () => {
    h.enabled = false;
    expect((await fire(promoteRoute))._getStatusCode()).toBe(403);
    expect(h.promoteCallableFunction).not.toHaveBeenCalled();
  });

  it("passes a refusal's reason through", async () => {
    h.promoteCallableFunction.mockRejectedValue(
      new ConflictError('Output stress was removed since promotion 1.', { code: 'breaking_change', changes: [] })
    );
    const res = await fire(promoteRoute);
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({
      code: 'breaking_change',
      error: 'Output stress was removed since promotion 1.',
    });
  });
});

describe('PUT /api/callable-functions/[id]/examples', () => {
  it("saves the owner's worked examples", async () => {
    const res = await fire(examplesRoute, { method: 'PUT', body: { examples: [EXAMPLE] } });
    expect(res._getStatusCode()).toBe(200);
    expect(h.setCallableFunctionExamples).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jwt-user' }),
      FUNCTION_ID,
      [EXAMPLE]
    );
  });

  it('refuses an example without a citation', async () => {
    const { citation: _citation, ...uncited } = EXAMPLE;
    const res = await fire(examplesRoute, { method: 'PUT', body: { examples: [uncited] } });
    expect(res._getStatusCode()).toBe(400);
    expect(h.setCallableFunctionExamples).not.toHaveBeenCalled();
  });

  it('answers 403 with the setting off', async () => {
    h.enabled = false;
    expect((await fire(examplesRoute, { method: 'PUT', body: { examples: [] } }))._getStatusCode()).toBe(403);
    expect(h.setCallableFunctionExamples).not.toHaveBeenCalled();
  });
});

describe('GET /api/callable-functions/[id]/calls', () => {
  it("returns the owner's call summary", async () => {
    const res = await fire(callsRoute, { method: 'GET' });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ total: 0, outcomes: {}, recent: [] });
    expect(h.summarizeCallableFunctionCalls).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jwt-user' }),
      FUNCTION_ID
    );
  });

  it('answers 401 without a session and 403 with the setting off', async () => {
    expect((await fire(callsRoute, { method: 'GET' }, {}))._getStatusCode()).toBe(401);
    h.enabled = false;
    expect((await fire(callsRoute, { method: 'GET' }))._getStatusCode()).toBe(403);
    expect(h.summarizeCallableFunctionCalls).not.toHaveBeenCalled();
  });
});

describe('no route that takes a body can set what a promotion writes', () => {
  const PROTECTED = {
    trustLabel: { trustLabel: 'verified' },
    runtime: { pin: { runtime: { kind: 'pyodide-server', version: '0.25.1', packages: [] } } },
    results: { lastServerRun: { passed: 9, failed: 0, results: [] } },
    sequence: { pin: { seq: 9 } },
    state: { state: 'live' },
    caseResults: { caseResults: { pinVersion: 1, cases: [] } },
    grants: { grants: { visibility: 'organization', organizationId: 'org-1', userIds: [] } },
  };
  const ROUTES = [
    ['POST /api/callable-functions', collectionRoute, 'POST', { artifactId: 'a1', expectedVersion: 1, contract: {} }],
    ['PATCH /api/callable-functions/[id]', functionRoute, 'PATCH', { enabled: true }],
    ['POST [id]/pin', pinRoute, 'POST', { expectedVersion: 1, contract: {} }],
    ['POST [id]/test-run', testRunRoute, 'POST', {}],
    ['POST [id]/promote', promoteRoute, 'POST', {}],
    ['PUT [id]/examples', examplesRoute, 'PUT', { examples: [] }],
  ] as const;
  const SERVICES = [
    h.createCallableFunction,
    h.setCallableFunctionEnabled,
    h.repinCallableFunction,
    h.runCallableFunctionTests,
    h.promoteCallableFunction,
    h.setCallableFunctionExamples,
  ];

  it.each(
    ROUTES.flatMap(([name, route, method, valid]) =>
      Object.entries(PROTECTED).map(([field, extra]) => [name, field, route, method, { ...valid, ...extra }] as const)
    )
  )('%s refuses a body that sets the %s', async (_name, _field, route, method, body) => {
    const res = await fire(route, { method, body });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ code: 'invalid_body' });
    for (const service of SERVICES) expect(service).not.toHaveBeenCalled();
  });

  it('refuses the same fields inside a worked example', async () => {
    const res = await fire(examplesRoute, {
      method: 'PUT',
      body: { examples: [{ ...EXAMPLE, trustLabel: 'verified' }] },
    });
    expect(res._getStatusCode()).toBe(400);
    expect(h.setCallableFunctionExamples).not.toHaveBeenCalled();
  });
});
