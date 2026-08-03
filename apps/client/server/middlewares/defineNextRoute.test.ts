// @vitest-environment node
/**
 * Tests for the contract -> Next.js route adapter.
 *
 * Like chat.integration.test.ts, this drives the REAL next-connect chain that
 * `baseApi` assembles rather than a passthrough mock, because everything under
 * test here is about WHICH middlewares get installed and IN WHAT ORDER. Only the
 * data/AWS edges are stubbed.
 *
 * `chat.contract.ts` is `apiKeyOrJwt` with non-empty scopes, so the adapter's other
 * branches (`jwtOnly`, `public`, empty `scopes`) have no reachable input anywhere in
 * the repo. These local fixture contracts exercise them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import { z } from 'zod';

const { mockValidate, mockFindById, mockApiKeyRateLimit } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindById: vi.fn(),
  mockApiKeyRateLimit: vi.fn(),
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  // extractApiKeyFromHeaders stays real - apiKeyAuth's header parsing is under test.
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockApiKeyRateLimit(...a),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
  };
});

// The real JWT verifier needs SST secrets, so it is stubbed - with two properties
// that the assertions below depend on and a naive stub would silently destroy:
//
//  1. It REJECTS when there is no JWT. A stub that always authenticates makes every
//     jwtOnly assertion vacuous.
//  2. It is an `nc()` SUB-ROUTER, matching the real export (server/auth/auth.ts:61).
//     next-connect skips its no-match 404 whenever a matched handler lacks the
//     internal method symbol, and a mounted sub-router is exactly such a handler.
//     Stubbing `auth` as a plain function would restore the 404 for free and make
//     the method-routing test pass no matter what the adapter does.
const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const nc = (await import('next-connect')).default;
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  const authRouter = nc<any, any>().use((req: any, _res: any, next: any) => {
    if (req.user) return next(); // already authenticated upstream (api key)
    const header = req.headers.authorization as string | undefined;
    if (header?.startsWith('Bearer ') && !header.includes('b4m_')) {
      req.user = JWT_USER;
      return next();
    }
    next(new UnauthorizedError('Unauthorized'));
  });
  return { ...actual, auth: authRouter };
});

import { ApiKeyScope, defineEndpoint } from '@bike4mind/common';
import { UnauthorizedError } from '@server/utils/errors';
import { nextRouteForContract } from './defineNextRoute';

const BodySchema = z.object({ message: z.string(), count: z.number().positive().default(1) });
const OkSchema = z.object({ ok: z.boolean() });

const makeContract = (over: Partial<Parameters<typeof defineEndpoint>[0]> = {}) =>
  defineEndpoint({
    method: 'post',
    path: '/api/fixture',
    operationId: 'fixtureOp',
    summary: 'Fixture',
    auth: 'apiKeyOrJwt',
    scopes: [ApiKeyScope.AI_CHAT],
    request: BodySchema,
    responses: { 200: { description: 'ok', schema: OkSchema } },
    ...over,
  });

function fire({ method = 'POST', apiKey = null as string | null, jwt = false, body = { message: 'hi' } as unknown }) {
  const payload = JSON.stringify(body);
  const { req, res } = createMocks(
    {
      method: method as 'POST',
      url: '/api/fixture',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(jwt ? { authorization: 'Bearer header.payload.sig' } : {}),
      },
      body,
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express types the
  // next-connect handler is typed against; the sibling tests cast the same way.
  return { req: req as any, res: res as any };
}

const validKey = (scopes: ApiKeyScope[]) =>
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });

describe('nextRouteForContract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue({ id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false });
    mockApiKeyRateLimit.mockResolvedValue({ allowed: true, headers: {} });
  });

  describe('auth: jwtOnly', () => {
    // The api-key chain must not be INSTALLED, not merely compensated for after the
    // fact: rejecting a key downstream of apiKeyAuth would still validate, meter,
    // audit and bill it first.
    it('401s an api-key caller without ever validating the key', async () => {
      validKey([ApiKeyScope.AI_CHAT]);
      const handlerFn = vi.fn();
      const route = nextRouteForContract(makeContract({ auth: 'jwtOnly' })).post(handlerFn);

      const { req, res } = fire({ apiKey: 'b4m_live_key' });
      await route(req, res);

      expect(res._getStatusCode()).toBe(401);
      expect(handlerFn).not.toHaveBeenCalled();
      // Load-bearing: proves apiKeyAuth was never installed. Collapsing jwtOnly back
      // to `baseApi({ auth: true })` plus a post-hoc guard fails right here.
      expect(mockValidate).not.toHaveBeenCalled();
      expect(mockApiKeyRateLimit).not.toHaveBeenCalled();
    });

    it('admits a JWT caller', async () => {
      const route = nextRouteForContract(makeContract({ auth: 'jwtOnly' })).post((_req, res) =>
        res.status(200).json({ ok: true })
      );
      const { req, res } = fire({ jwt: true });
      await route(req, res);
      expect(res._getStatusCode()).toBe(200);
    });
  });

  describe('scopes', () => {
    it('admits any valid key when the contract declares an empty scopes array', async () => {
      // `scopes: []` means "no scope requirement". Passing it straight through to
      // apiKeyAuth would make `requiredScopes.some(...)` always false and 403 every key.
      validKey([ApiKeyScope.READ_FILES]);
      const route = nextRouteForContract(makeContract({ scopes: [] })).post((_req, res) =>
        res.status(200).json({ ok: true })
      );
      const { req, res } = fire({ apiKey: 'b4m_live_key' });
      await route(req, res);
      expect(res._getStatusCode()).toBe(200);
    });

    it('403s an under-scoped key when the contract declares scopes', async () => {
      validKey([ApiKeyScope.READ_FILES]);
      const handlerFn = vi.fn();
      const route = nextRouteForContract(makeContract()).post(handlerFn);
      const { req, res } = fire({ apiKey: 'b4m_live_key' });
      await route(req, res);
      expect(res._getStatusCode()).toBe(403);
      expect(handlerFn).not.toHaveBeenCalled();
    });
  });

  describe('middleware ordering', () => {
    it('runs caller-mounted middleware BEFORE contract validation', async () => {
      // The regression this guards: installing validation with `router.use()` at
      // construction time puts it ahead of everything the caller mounts, so a flood
      // of malformed bodies 422s without ever reaching the rate limiter.
      const limiter = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
      const handlerFn = vi.fn();
      const route = nextRouteForContract(makeContract())
        // any: the fixture middleware isn't typed as the adapter's ValidatedReq handler.
        .use(limiter as any)
        .post(handlerFn);

      validKey([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire({ apiKey: 'b4m_live_key', body: { message: 'hi', count: -1 } });
      await route(req, res);

      expect(res._getStatusCode()).toBe(422);
      expect(limiter).toHaveBeenCalledTimes(1);
      expect(handlerFn).not.toHaveBeenCalled();
    });

    it('validates and exposes the parsed body as req.validated', async () => {
      validKey([ApiKeyScope.AI_CHAT]);
      let seen: unknown;
      const route = nextRouteForContract(makeContract()).post((req, res) => {
        seen = req.validated;
        res.status(200).json({ ok: true });
      });
      const { req, res } = fire({ apiKey: 'b4m_live_key', body: { message: 'hi' } });
      await route(req, res);
      expect(res._getStatusCode()).toBe(200);
      // `count` came from the schema default, so validation genuinely ran.
      expect(seen).toEqual({ message: 'hi', count: 1 });
    });

    it('404s a method the contract does not declare, rather than 422ing it', async () => {
      // A `use`-mounted validator matches EVERY method, so GET would be validated and
      // rejected as a bad POST body instead of falling through to next-connect's
      // no-match 404. The body here is deliberately invalid: with a valid one both
      // orderings end in 404 and the test would prove nothing.
      validKey([ApiKeyScope.AI_CHAT]);
      const route = nextRouteForContract(makeContract()).post((_req, res) => res.status(200).json({ ok: true }));
      const { req, res } = fire({ method: 'GET', apiKey: 'b4m_live_key', body: {} });
      await route(req, res);
      expect(res._getStatusCode()).toBe(404);
    });
  });

  describe('verb binding (P3-1)', () => {
    it('throws when a handler is registered on a verb other than the contract method', () => {
      // A POST contract wired via .get(handler) would serve GET with validation on the
      // wrong verb - fail loud at registration instead.
      expect(() => nextRouteForContract(makeContract()).get(vi.fn())).toThrow(/method 'post'/i);
      expect(() => nextRouteForContract(makeContract({ method: 'put' })).post(vi.fn())).toThrow(/method 'put'/i);
    });

    it('throws for the registrars that previously bypassed the prelude (.all/.head/.options/.trace)', () => {
      // These were not wrapped before, so a handler mounted on them left req.validated
      // undefined and skipped the drift check. They now match no single-method contract.
      for (const verb of ['all', 'head', 'options', 'trace'] as const) {
        const route = nextRouteForContract(makeContract()) as unknown as Record<string, (h: unknown) => unknown>;
        expect(() => route[verb](vi.fn()), verb).toThrow(/method 'post'/i);
      }
    });
  });
});
