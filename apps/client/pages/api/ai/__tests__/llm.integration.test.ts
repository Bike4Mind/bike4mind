// @vitest-environment node
/**
 * Integration test for POST /api/ai/llm scope enforcement.
 *
 * Drives the real next-connect chain `baseApi` assembles (see
 * generate-image.integration.test.ts for the rationale) to prove the
 * `baseApi({ requiredScopes: [AI_CHAT] })` wiring reaches `apiKeyAuth`: a key lacking
 * `ai:chat` is rejected 403 before the handler runs, so no billed chat completion is
 * dispatched. A key holding it, and JWT/browser callers, pass through.
 *
 * The route's mint catalogue entry (`apiKeyScopes.ts`, AI_CHAT) advertises this gate to
 * anyone creating a key, so losing `requiredScopes` again would put that prose back ahead
 * of the code - this suite is what fails if it goes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const {
  mockValidate,
  mockUserFindById,
  mockUserUpdate,
  mockApiKeyRateLimit,
  mockTryIncrement,
  mockGetOrCreateSession,
  mockInvoke,
  mockWillInjectAuthoredPrompt,
  mockLoadIdentityPrompts,
  mockOrgFindAccessibleById,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockUserFindById: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockApiKeyRateLimit: vi.fn(),
  mockTryIncrement: vi.fn(),
  mockGetOrCreateSession: vi.fn(),
  mockInvoke: vi.fn(),
  mockWillInjectAuthoredPrompt: vi.fn(),
  mockLoadIdentityPrompts: vi.fn(),
  mockOrgFindAccessibleById: vi.fn(),
}));

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit-Minute': '60',
  'X-RateLimit-Remaining-Minute': '59',
  'X-RateLimit-Reset-Minute': '0',
  'X-RateLimit-Limit-Day': '1000',
  'X-RateLimit-Remaining-Day': '999',
  'X-RateLimit-Reset-Day': '0',
};

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  // Keep the real (pure) extractApiKeyFromHeaders - apiKeyAuth imports it; only
  // checkApiKeyRateLimit is stubbed.
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockApiKeyRateLimit(...a),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

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

vi.mock('@bike4mind/utils', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  SQSService: class {},
}));

// connectDB must not hit Mongo; User.findById backs apiKeyAuth's user lookup, and
// cacheRepository backs the route's own in-memory rateLimit middleware.
vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockUserFindById(...a) }),
    userRepository: {
      ...(actual.userRepository as object),
      update: (...a: unknown[]) => mockUserUpdate(...a),
    },
    cacheRepository: {
      ...(actual.cacheRepository as object),
      tryIncrementWithinLimitFixedWindow: (...a: unknown[]) => mockTryIncrement(...a),
    },
    // resolveBillingOrgId -> resolveActiveOrg run for real here; only the org-membership repo call
    // is stubbed, so the billing wiring (route -> resolver -> gate) is exercised end to end.
    organizationRepository: {
      ...(actual.organizationRepository as object),
      shareable: {
        ...((actual.organizationRepository as { shareable?: object })?.shareable ?? {}),
        findAccessibleById: (...a: unknown[]) => mockOrgFindAccessibleById(...a),
      },
    },
  };
});

vi.mock('@server/managers/sessionManager', () => ({
  getOrCreateSession: (...a: unknown[]) => mockGetOrCreateSession(...a),
}));

vi.mock('@server/utils/chatCompletionDefaults', () => ({
  getDefaultChatCompletionOptions: () => ({}),
  getSharedTokenizer: () => ({}),
}));

vi.mock('@server/utils/sessionSystemPromptResolver', () => ({
  sessionWillInjectAuthoredPrompt: (...a: unknown[]) => mockWillInjectAuthoredPrompt(...a),
}));

vi.mock('@server/utils/systemPrompts/loader', () => ({
  loadBaseIdentitySystemPromptMessages: (...a: unknown[]) => mockLoadIdentityPrompts(...a),
}));

// Never reached: the real invokeLambda callback is owned by the mocked
// ChatCompletionInvoke. Stubbed so the module's transitive AWS edges stay out of the test.
vi.mock('@server/utils/dispatchQuest', () => ({ dispatchQuest: vi.fn().mockResolvedValue(undefined) }));

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

import handler from '../llm';
import { ApiKeyScope } from '@bike4mind/common';

const VALID_KEY = 'sk-test-valid-key';
const OWN_ORG = '650000000000000000000abc';
const FOREIGN_ORG = '650000000000000000000def';

function fire({
  apiKey = VALID_KEY as string | null,
  body,
}: { apiKey?: string | null; body?: Record<string, unknown> } = {}) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/ai/llm',
      body: { sessionId: 'sess-1', message: 'Hello there', ...body },
      headers: { ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

function validateWithScopes(scopes: ApiKeyScope[] | string[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

describe('POST /api/ai/llm (integration - ai:chat scope enforcement)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue({ id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false });
    mockApiKeyRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
    mockTryIncrement.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 60_000) });
    mockUserUpdate.mockResolvedValue(undefined);
    mockWillInjectAuthoredPrompt.mockResolvedValue(false);
    mockLoadIdentityPrompts.mockResolvedValue([]);
    mockGetOrCreateSession.mockResolvedValue({
      sessionId: 'sess-1',
      asyncPromises: [],
      session: { id: 'sess-1', name: 'Test Session' },
    });
    mockInvoke.mockResolvedValue({ id: 'quest-1', status: 'pending' });
  });

  it('rejects a key lacking ai:chat (403) before dispatching any billed completion', async () => {
    validateWithScopes([ApiKeyScope.READ_NOTEBOOKS]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(mockInvoke).not.toHaveBeenCalled();
    // The 403 lands before the handler body, so no session is created as a side effect.
    expect(mockGetOrCreateSession).not.toHaveBeenCalled();
  });

  it('rejects an ai:generate-only key (403) - this route is narrower than /api/chat', async () => {
    // Pins the deliberate narrowing: the contract surfaces accept [AI_CHAT, AI_GENERATE] to
    // preserve legacy completions behavior, this route accepts AI_CHAT alone (see llm.ts).
    // Widening it later should be a conscious edit, not a silent one.
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('accepts a key with ai:chat (200) and dispatches the quest', async () => {
    validateWithScopes([ApiKeyScope.AI_CHAT]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ quest: { id: 'quest-1' } });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('leaves JWT/browser callers unaffected (200, no api key)', async () => {
    const { req, res } = fire({ apiKey: null });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  // Billing-org wiring: resolveBillingOrgId -> the real resolveActiveOrg -> the (stubbed) org
  // membership gate. A body organizationId the caller cannot access must not reach invoke().
  it('denies a client-supplied org the caller is not a member of (403, no completion dispatched)', async () => {
    validateWithScopes([ApiKeyScope.AI_CHAT]);
    mockOrgFindAccessibleById.mockResolvedValue(null); // non-member -> gate throws ForbiddenError
    const { req, res } = fire({ body: { organizationId: FOREIGN_ORG } });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('bills the caller own org when the request omits organizationId', async () => {
    validateWithScopes([ApiKeyScope.AI_CHAT]);
    mockUserFindById.mockResolvedValue({
      id: 'user-1',
      _id: 'user-1',
      organizationId: OWN_ORG,
      isBanned: false,
      disputePending: false,
    });
    mockOrgFindAccessibleById.mockResolvedValue({ id: OWN_ORG }); // member -> gate resolves
    const { req, res } = fire(); // body carries no organizationId
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][0].body.organizationId).toBe(OWN_ORG);
  });

  // invoke()'s own parse already rejects a bad systemPrompt, but only after getOrCreateSession
  // has written a session and moved lastNotebookId. What these pin is that the rejection happens
  // before that - hence the assertions on mockGetOrCreateSession, not just the status.
  it('rejects an oversized systemPrompt (422) before creating a session or quest', async () => {
    const { req, res } = fire({ body: { systemPrompt: 'x'.repeat(16_001) } });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData().code).toBe('SYSTEM_PROMPT_TOO_LONG');
    // errorHandler's own 422 envelope puts the human text in `error` and has no `message` key,
    // so the guard's body matches the shape every other error on this route returns.
    expect(res._getJSONData().error).toContain('16000');
    expect(mockGetOrCreateSession).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('rejects a non-string systemPrompt (422) before creating a session or quest', async () => {
    const { req, res } = fire({ body: { systemPrompt: 12_345 as unknown as string } });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData().code).toBe('SYSTEM_PROMPT_INVALID');
    expect(mockGetOrCreateSession).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('accepts a systemPrompt at exactly the cap (200) and forwards it to invoke', async () => {
    const atCap = 'x'.repeat(16_000);
    const { req, res } = fire({ body: { systemPrompt: atCap } });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][0].body.systemPrompt).toBe(atCap);
  });
});
