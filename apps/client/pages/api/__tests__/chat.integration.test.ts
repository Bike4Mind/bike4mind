// @vitest-environment node
/**
 * Integration test for POST /api/chat scope enforcement.
 *
 * Like events.integration.test.ts, this imports the REAL handler and drives the
 * full next-connect chain that `baseApi` assembles (logging -> body-size guard ->
 * connectDB -> passport -> apiKeyAuth -> anomaly detection -> rate-limit -> JWT auth ->
 * handler). Only data/AWS edges are stubbed. What this test proves is the piece
 * the passthrough-mocked unit tests cannot: the `baseApi({ requiredScopes })`
 * wiring actually reaches `apiKeyAuth`, so an under-scoped key is rejected with
 * 403 *before* the handler runs.
 *
 * /api/chat opts into `[AI_CHAT, AI_GENERATE]` with OR semantics (parity with
 * /api/ai/v1/completions), so a key holding *either* scope passes.
 *
 * The handler is driven down its async path (wait defaults false) with an
 * explicit sessionId, so `ChatCompletionProcess` and the getSessionId lookups
 * never run - only `ChatCompletionInvoke.invoke` needs to return a quest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockFindById, mockRateLimit, mockInvoke, mockGetSettingsMap } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockInvoke: vi.fn(),
  mockGetSettingsMap: vi.fn(),
}));

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit-Minute': '60',
  'X-RateLimit-Remaining-Minute': '59',
  'X-RateLimit-Reset-Minute': '0',
  'X-RateLimit-Limit-Day': '1000',
  'X-RateLimit-Remaining-Day': '999',
  'X-RateLimit-Reset-Day': '0',
};

// The Mongo-backed per-API-key rate-limit counter (buffers forever against a
// stubbed connectDB otherwise). Overridable per-test.
vi.mock('@server/utils/apiKeyRateLimitCheck', () => ({
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

// Keep fire-and-forget analytics writes from touching the DB.
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

// The per-user tier rate-limit middleware runs before the handler and
// resolves the caller's limit from their active subscriptions (a Mongo read via
// subscriptionRepository). This test stubs connectDB, so that read would buffer
// forever - return Infinity ("no limit") so the middleware skips enforcement and
// the test stays focused on apiKeyAuth scope enforcement.
vi.mock('@server/utils/userRateTier', () => ({
  resolveUserRateLimitPerMin: vi.fn().mockResolvedValue(Infinity),
}));

// Chat's own in-memory rateLimit + the settings load both reach the DB - stub
// their edges. getSettingsValue stays real (with {} it falls back to the default
// model). SQSService is inert; the tokenizer/default-options are irrelevant to
// the async response.
vi.mock('@server/utils/chatCompletionDefaults', () => ({
  getDefaultChatCompletionOptions: () => ({}),
  getSharedTokenizer: () => ({}),
  // Hosted-path shape: no apiKeys/models, so chat.ts skips the self-host usability guard.
  resolveDefaultChatModel: async ({ configuredModel }: { configuredModel?: string | null }) => ({
    model: configuredModel || 'test-default-model',
  }),
  isChatModelUsable: () => true,
}));

// Only the data dependencies of the real apiKeyAuth middleware and the chat
// invoke are controlled; header parsing, scope check, and error->status mapping
// all run for real.
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  class MockChatCompletionInvoke {
    prefetchedSession = undefined;
    prefetchedOrganization = undefined;
    invoke = (...a: unknown[]) => mockInvoke(...a);
  }
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
    ChatCompletionInvoke: MockChatCompletionInvoke,
  };
});

vi.mock('@bike4mind/utils', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    getSettingsMap: (...a: unknown[]) => mockGetSettingsMap(...a),
    SQSService: class {},
  };
});

// connectDB must not hit Mongo; User.findById is stubbed so apiKeyAuth's user
// lookup resolves; cacheRepository backs chat's in-memory rateLimit middleware.
vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
    cacheRepository: {
      ...(actual.cacheRepository as object),
      tryIncrementWithinLimitFixedWindow: vi
        .fn()
        .mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 60_000) }),
    },
  };
});

// A successful JWT verifier for the "JWT unaffected" case. authMiddleware is
// preserved; only the final `auth` verifier is overridden, and only when no
// user is already set (so it never clobbers the api-key path).
const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, _res: any, next: any) => {
      if (!req.user) req.user = JWT_USER;
      next();
    },
  };
});

import handler from '../chat';
import { ApiKeyScope } from '@bike4mind/common';

const VALID_KEY = 'sk-test-valid-key';

function fire({
  apiKey = VALID_KEY as string | null,
  bearer = null as string | null,
  body = { message: 'hello', sessionId: 'sess-1' },
}: { apiKey?: string | null; bearer?: string | null; body?: unknown } = {}) {
  const payload = JSON.stringify(body);
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/chat',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body,
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response
  // the next-connect handler is typed against; the sibling tests cast the same way.
  return { req: req as any, res: res as any };
}

// A valid key whose scopes we set per-test.
function validateWithScopes(scopes: ApiKeyScope[] | string[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

describe('POST /api/chat (integration — scope enforcement via real middleware chain)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettingsMap.mockResolvedValue({});
    mockInvoke.mockResolvedValue({ id: 'quest-1', status: 'queued' });
    mockFindById.mockReturnValue(
      Promise.resolve({
        id: 'user-1',
        _id: 'user-1',
        isBanned: false,
        disputePending: false,
        organizationId: undefined,
      })
    );
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
  });

  it('rejects a key holding neither ai:chat nor ai:generate (403)', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('accepts a key with ai:chat (2xx) and queues the quest', async () => {
    validateWithScopes([ApiKeyScope.AI_CHAT]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: 'quest-1', message_received: true });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('accepts an ai:generate-only key (2xx) — proves OR semantics', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('rejects a valid key with an empty scope array (403, fail-closed)', async () => {
    validateWithScopes([]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('rejects an under-scoped api key even when a valid Bearer JWT is co-present (403 — the presented key wins)', async () => {
    // apiKeyAuth runs before the JWT verifier and 403s on the key's scopes, so a
    // co-present session cannot "rescue" an under-scoped key.
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = fire({ bearer: 'valid-jwt-token' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('leaves JWT/browser callers unaffected (2xx, no api key)', async () => {
    const { req, res } = fire({ apiKey: null });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    // scope validation never ran - this request was never an api-key caller
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});
