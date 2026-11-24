// @vitest-environment node
/**
 * POST /api/callable-functions/[id]/test-run through the real `baseApi` chain and error handler, with the session
 * check, the setting, and the test runner stubbed. The runner's own rules are in
 * packages/server-utils/src/callableFunctions/testRun.test.ts and dispatch.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { ConflictError, NotFoundError, ServiceUnavailableError, UnprocessableEntityError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  enabled: true,
  noUser: false,
  perUserBuckets: [] as string[],
  validateApiKey: vi.fn(),
  runCallableFunctionTests: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/callableFunctions/testRun', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/callableFunctions/testRun')>()),
  runCallableFunctionTests: h.runCallableFunctionTests,
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

import testRunRoute from '../[id]/test-run';

const FUNCTION_ID = '6650f0a1b2c3d4e5f6a7b8c9';
const RUN = {
  functionId: FUNCTION_ID,
  passed: 1,
  failed: 1,
  results: [
    { name: 'short span', passed: true, outcome: 'ok', mismatch: null, durationMs: 31, callId: 'call-1' },
    { name: 'long span', passed: false, outcome: 'timeout', mismatch: null, durationMs: 30_000, callId: 'call-2' },
  ],
};

async function fire(
  { method = 'POST', body = {} as unknown } = {},
  headers: Record<string, string> = { authorization: 'Bearer live-jwt' }
) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>(
    {
      method: method as 'POST',
      url: `/api/callable-functions/${FUNCTION_ID}/test-run`,
      query: { id: FUNCTION_ID },
      body: body as never,
      headers: { 'content-type': 'application/json', ...headers },
    },
    { eventEmitter: EventEmitter }
  );
  await (testRunRoute as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

beforeEach(() => {
  h.enabled = true;
  h.noUser = false;
  h.validateApiKey.mockReset();
  h.runCallableFunctionTests.mockReset();
  h.runCallableFunctionTests.mockResolvedValue(RUN);
});

describe('POST /api/callable-functions/[id]/test-run', () => {
  it("returns each case's result, timing, and call-log row id for the signed-in owner", async () => {
    const res = await fire();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(RUN);
    expect(h.runCallableFunctionTests).toHaveBeenCalledWith(expect.objectContaining({ id: 'jwt-user' }), FUNCTION_ID, {
      budgetMs: 45_000,
    });
  });

  it('runs only the named tests, and lowers the budget only through its setting', async () => {
    vi.stubEnv('CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS', '8000');
    const res = await fire({ body: { tests: ['long span'] } });
    vi.unstubAllEnvs();
    expect(res._getStatusCode()).toBe(200);
    expect(h.runCallableFunctionTests).toHaveBeenCalledWith(expect.anything(), FUNCTION_ID, {
      tests: ['long span'],
      budgetMs: 8_000,
    });
  });

  it('uses its own per-user rate limit bucket', () => {
    expect(h.perUserBuckets).toEqual(['POST /api/callable-functions/[id]/test-run']);
  });

  it('answers 401 without a session, and for an API key without looking it up', async () => {
    expect((await fire({}, {}))._getStatusCode()).toBe(401);
    const keyed = await fire({}, { 'x-api-key': 'b4m_live_0123456789abcdef0123456789abcdef' });
    expect(keyed._getStatusCode()).toBe(401);
    expect(h.validateApiKey).not.toHaveBeenCalled();
    expect(h.runCallableFunctionTests).not.toHaveBeenCalled();
  });

  it('answers 401 when the session has no user', async () => {
    h.noUser = true;
    const res = await fire();
    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData()).toMatchObject({ error: 'Sign in to use callable functions.' });
    expect(h.runCallableFunctionTests).not.toHaveBeenCalled();
  });

  it('answers 403 with the setting off and runs nothing', async () => {
    h.enabled = false;
    const res = await fire();
    expect(res._getStatusCode()).toBe(403);
    expect(h.runCallableFunctionTests).not.toHaveBeenCalled();
  });

  it.each([
    ['a test case instead of a name', { tests: [{ name: 'forged', input: {}, expected: {} }] }],
    ['the contract', { contract: { name: 'forged' } }],
    ['an empty list of names', { tests: [] }],
  ])('refuses a body naming %s, since the server reads the tests itself', async (_name, body) => {
    const res = await fire({ body });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ code: 'invalid_body' });
    expect(h.runCallableFunctionTests).not.toHaveBeenCalled();
  });

  it('runs nothing for another method', async () => {
    expect((await fire({ method: 'GET' }))._getStatusCode()).toBe(404);
    expect(h.runCallableFunctionTests).not.toHaveBeenCalled();
  });

  it.each([
    [404, new NotFoundError('Tool not found'), {}],
    [
      409,
      new ConflictError('This tool is turned off.', { code: 'not_callable', status: 'disabled' }),
      { code: 'not_callable' },
    ],
    [
      422,
      new UnprocessableEntityError('The server could not read the function contract.', {
        code: 'contract_unreadable',
        outcome: 'timeout',
      }),
      { code: 'contract_unreadable' },
    ],
    [
      503,
      new ServiceUnavailableError('The runtime is starting. Try again in a minute.', { code: 'runtime_starting' }),
      { code: 'runtime_starting', error: 'The runtime is starting. Try again in a minute.' },
    ],
  ])('passes a %i from the runner through', async (status, error, body) => {
    h.runCallableFunctionTests.mockRejectedValue(error);
    const res = await fire();
    expect(res._getStatusCode()).toBe(status);
    expect(res._getJSONData()).toMatchObject(body);
  });
});
