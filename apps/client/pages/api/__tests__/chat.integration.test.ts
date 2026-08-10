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

const {
  mockValidate,
  mockFindById,
  mockRateLimit,
  mockInvoke,
  mockProcess,
  mockGetSettingsMap,
  mockResolveDefaultChatModel,
  mockIsChatModelUsable,
  mockTryIncrement,
  mockResolveUserRateLimitPerMin,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockInvoke: vi.fn(),
  mockProcess: vi.fn(),
  mockGetSettingsMap: vi.fn(),
  mockResolveDefaultChatModel: vi.fn(),
  mockIsChatModelUsable: vi.fn(),
  mockTryIncrement: vi.fn(),
  mockResolveUserRateLimitPerMin: vi.fn(),
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
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  // Keep the real (pure) extractApiKeyFromHeaders - apiKeyAuth imports it now; only
  // checkApiKeyRateLimit is stubbed.
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

// Keep fire-and-forget analytics writes from touching the DB.
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

// The per-user tier rate-limit middleware resolves the caller's limit from their
// active subscriptions (a Mongo read via subscriptionRepository). This test stubs
// connectDB, so that read would buffer forever - stub it instead.
//
// It resolves to a FINITE limit by default. An earlier `Infinity` here meant the
// limiter short-circuited before its counter, so no chat test - happy path included -
// ever exercised the increment, and the whole rate-limit-vs-validation ordering was
// untested. Individual tests override it.
vi.mock('@server/utils/userRateTier', () => ({
  resolveUserRateLimitPerMin: (...a: unknown[]) => mockResolveUserRateLimitPerMin(...a),
}));

// Chat's own in-memory rateLimit + the settings load both reach the DB - stub
// their edges. getSettingsValue stays real (with {} it falls back to the default
// model). SQSService is inert; the tokenizer/default-options are irrelevant to
// the async response.
vi.mock('@server/utils/chatCompletionDefaults', () => ({
  getDefaultChatCompletionOptions: () => ({}),
  getSharedTokenizer: () => ({}),
  resolveDefaultChatModel: (...a: unknown[]) => mockResolveDefaultChatModel(...a),
  isChatModelUsable: (...a: unknown[]) => mockIsChatModelUsable(...a),
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
  // The wait=true path constructs this directly; the async-path tests never reach it.
  class MockChatCompletionProcess {
    pipelinePhases = undefined;
    process = (...a: unknown[]) => mockProcess(...a);
  }
  return {
    ...actual,
    ChatCompletionProcess: MockChatCompletionProcess,
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
      // Hoisted so tests can assert the per-user limiter actually ran, and drive
      // the over-limit path.
      tryIncrementWithinLimitFixedWindow: (...a: unknown[]) => mockTryIncrement(...a),
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
import { Types } from 'mongoose';

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
    mockResolveUserRateLimitPerMin.mockResolvedValue(60);
    mockTryIncrement.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 60_000) });
    // Hosted-path shape: no apiKeys/models, so chat.ts skips the self-host usability guard.
    mockResolveDefaultChatModel.mockImplementation(
      async ({ configuredModel }: { configuredModel?: string | null }) => ({
        model: configuredModel || 'test-default-model',
      })
    );
    mockIsChatModelUsable.mockReturnValue(true);
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

  // F1: apiKeyAuth must accept the canonical `Authorization: Bearer b4m_<key>` form
  // (what the OpenAPI spec + code samples advertise), while a Bearer JWT still
  // falls through to JWT auth.
  it('authenticates Authorization: Bearer b4m_<key> as an API key', async () => {
    validateWithScopes([ApiKeyScope.AI_CHAT]);
    const { req, res } = fire({ apiKey: null, bearer: 'b4m_live_testkey' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    // Went the API-key route (not JWT): the key validator ran with the Bearer token.
    expect(mockValidate).toHaveBeenCalledWith('b4m_live_testkey', expect.anything());
  });

  it('leaves a Bearer JWT (no b4m_ prefix) to JWT auth, not api-key auth', async () => {
    const { req, res } = fire({ apiKey: null, bearer: 'eyJhbGciOi.jwt.token' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    // The api-key validator never ran - this was a JWT.
    expect(mockValidate).not.toHaveBeenCalled();
  });

  // The 200 above is NOT load-bearing on its own: this file's JWT stub authenticates
  // any caller, so a completely broken Bearer key path would still answer 200. These
  // assert the api-key ERROR paths, which only a real Bearer extraction can produce.
  it('403s an under-scoped key presented as Bearer', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = fire({ apiKey: null, bearer: 'b4m_live_testkey' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('401s an invalid key presented as Bearer', async () => {
    mockValidate.mockResolvedValue({ isValid: false, reason: 'revoked' });
    const { req, res } = fire({ apiKey: null, bearer: 'b4m_live_revoked' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(401);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // Only a `b4m_`-prefixed Bearer token is an API key. Anything else must fall
  // through to JWT auth rather than being sent to the key validator.
  it.each(['not_b4m_live_x', 'Bearerb4m_live_x', 'eyJhbGciOi.b4m_live.token'])(
    'does not treat Bearer %s as an api key',
    async token => {
      const { req, res } = fire({ apiKey: null, bearer: token });
      await handler(req, res);
      expect(mockValidate).not.toHaveBeenCalled();
    }
  );

  // Rate limiting must run BEFORE contract validation, or a flood of malformed
  // bodies costs a caller nothing. The discriminator is the limiter's own counter:
  // a 422 alone is returned by either ordering.
  describe('rate limit runs before validation', () => {
    const badBody = { message: 'hi', sessionId: 'sess-1', historyCount: -5 };

    it('counts a malformed body from an api-key caller against the limiter', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire({ body: badBody });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(mockTryIncrement).toHaveBeenCalledTimes(1);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('counts a malformed body from a JWT caller against the limiter', async () => {
      const { req, res } = fire({ apiKey: null, body: badBody });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(mockTryIncrement).toHaveBeenCalledTimes(1);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('429s an over-limit caller instead of 422ing their malformed body', async () => {
      // The sharpest pre-fix/post-fix discriminator: if validation ran first, this
      // request would never reach the limiter and would answer 422.
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      mockTryIncrement.mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 30_000) });
      const { req, res } = fire({ body: badBody });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(429);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('skips enforcement entirely for an unlimited (admin/dev) caller', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      mockResolveUserRateLimitPerMin.mockResolvedValue(Infinity);
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockTryIncrement).not.toHaveBeenCalled();
    });
  });

  it('returns 400 when the resolved default chat model is unusable (self-host, no key, no local model)', async () => {
    // Self-host resolver shape: apiKeys/models ARE present (unlike the hosted default),
    // so chat.ts runs its no-usable-model guard. An empty model list plus an unusable
    // default trips the 400 before any quest is created.
    validateWithScopes([ApiKeyScope.AI_CHAT]);
    mockResolveDefaultChatModel.mockResolvedValue({ model: 'test-default-model', apiKeys: {}, models: [] });
    mockIsChatModelUsable.mockReturnValue(false);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/no usable default chat model/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // Behaviour change: extracting the schema to the contract dropped
  // `historyCount`'s `.catch(10)` in favour of `.default(10)` (fail loud). An
  // invalid value now 422s instead of silently coercing to 10 (pre-PR behaviour).
  describe('historyCount fail-loud (behaviour change vs pre-contract .catch(10))', () => {
    it('rejects a non-positive historyCount with 422 (previously silently coerced to 10)', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire({ body: { message: 'hi', sessionId: 'sess-1', historyCount: 0 } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('defaults an omitted historyCount to 10 and proceeds (2xx)', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire({ body: { message: 'hi', sessionId: 'sess-1' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect((mockInvoke.mock.calls[0][0] as { body: { historyCount?: number } }).body.historyCount).toBe(10);
    });
  });

  // req.user.organizationId arrives as a Mongo ObjectId (or, after a .populate(),
  // a full Organization doc). It flows into the internal request at both top-level
  // `organizationId` and `promptMeta.session.organizationId`, where a downstream
  // schema parses it as z.string(). Un-normalized, an org-associated caller 422s
  // ("expected string, received ObjectId"). The handler must coerce to a hex string
  // at the boundary. The invoke stub here can't reproduce the downstream 422, so we
  // assert the shape it receives instead - that IS the fix.
  describe('organizationId boundary normalization', () => {
    const invokedBody = () =>
      mockInvoke.mock.calls[0][0] as {
        body: { organizationId?: unknown; promptMeta?: { session?: { organizationId?: unknown } } };
      };

    it('coerces an ObjectId organizationId to a hex string on both surfaces (no 422)', async () => {
      const orgId = new Types.ObjectId();
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      mockFindById.mockReturnValue(
        Promise.resolve({ id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false, organizationId: orgId })
      );
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      const { body } = invokedBody();
      expect(body.organizationId).toBe(orgId.toHexString());
      expect(body.promptMeta?.session?.organizationId).toBe(orgId.toHexString());
    });

    it('flattens a populated Organization document to its _id hex string, never "[object Object]"', async () => {
      const orgId = new Types.ObjectId();
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      mockFindById.mockReturnValue(
        Promise.resolve({
          id: 'user-1',
          _id: 'user-1',
          isBanned: false,
          disputePending: false,
          organizationId: { _id: orgId, name: 'Acme' },
        })
      );
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(invokedBody().body.organizationId).toBe(orgId.toHexString());
    });

    it('leaves organizationId absent for a personal (org-less) caller', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      // beforeEach already returns a user with organizationId: undefined.
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(invokedBody().body.organizationId).toBeUndefined();
    });
  });

  // Output-budget override: the handler must forward a caller-supplied token
  // budget into params.max_tokens regardless of casing. Reasoning models were
  // silently pinned to the 4096 default because Zod stripped the camelCase aliases.
  describe('max_tokens override coalescing', () => {
    const invokedParams = () =>
      (mockInvoke.mock.calls[0][0] as { body: { params: { max_tokens?: number } } }).body.params;

    it('honors snake_case max_tokens', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire({ body: { message: 'hi', sessionId: 'sess-1', max_tokens: 16000 } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(invokedParams().max_tokens).toBe(16000);
    });

    it('honors the camelCase maxTokens alias', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire({ body: { message: 'hi', sessionId: 'sess-1', maxTokens: 16000 } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(invokedParams().max_tokens).toBe(16000);
    });

    it('honors the maxOutputTokens alias', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire({ body: { message: 'hi', sessionId: 'sess-1', maxOutputTokens: 16000 } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(invokedParams().max_tokens).toBe(16000);
    });

    // Absence must stay absent on the wire. Substituting a number here would read
    // downstream as a deliberate caller budget and suppress the model-aware default
    // that gives adaptive reasoning models their output headroom.
    it('forwards no max_tokens at all when no budget is supplied', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire({ body: { message: 'hi', sessionId: 'sess-1' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(invokedParams().max_tokens).toBeUndefined();
    });
  });
});

describe('POST /api/chat (integration - wait path promptDetails exposure)', () => {
  // What process() leaves on the in-memory quest; the route must surface it only on request.
  const DETAILS = [{ source: 'hardcoded', name: 'date_time_context', tokenCount: 12, wasIncluded: true }];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettingsMap.mockResolvedValue({});
    mockInvoke.mockResolvedValue({
      id: 'quest-2',
      status: 'done',
      reply: 'hi',
      replies: ['hi'],
      createdAt: new Date('2026-08-03T00:00:00Z'),
      promptMeta: { context: { systemPromptDetails: DETAILS } },
    });
    mockProcess.mockResolvedValue(undefined);
    mockFindById.mockReturnValue(
      Promise.resolve({ id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false })
    );
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
    mockResolveDefaultChatModel.mockResolvedValue({ model: 'test-default-model' });
    mockIsChatModelUsable.mockReturnValue(true);
    mockValidate.mockResolvedValue({
      isValid: true,
      keyId: 'k1',
      userId: 'user-1',
      scopes: [ApiKeyScope.AI_CHAT],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
  });

  it('returns the per-source breakdown when includePromptDetails is set', async () => {
    const { req, res } = fire({
      body: { message: 'hello', sessionId: 'sess-1', wait: true, includePromptDetails: true },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().promptDetails).toEqual(DETAILS);
  });

  it('omits the breakdown without the flag, keeping the response shape unchanged', async () => {
    const { req, res } = fire({ body: { message: 'hello', sessionId: 'sess-1', wait: true } });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).not.toHaveProperty('promptDetails');
  });

  it('accepts promptMode: raw at the HTTP boundary', async () => {
    const { req, res } = fire({ body: { message: 'hello', sessionId: 'sess-1', promptMode: 'raw' } });
    await handler(req, res);
    expect(res._getStatusCode()).toBeGreaterThanOrEqual(200);
    expect(res._getStatusCode()).toBeLessThan(300);
  });

  it('rejects an unknown promptMode with 422 and a named field, not a 5xx', async () => {
    const { req, res } = fire({ body: { message: 'hello', sessionId: 'sess-1', promptMode: 'nonsense' } });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
  });
});
