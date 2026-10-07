// @vitest-environment node
/**
 * Integration test for POST /api/v1/image-generations (and its legacy alias
 * /api/ai/generate-image).
 *
 * Drives the real next-connect chain `nextRouteForContract` assembles (see quests/[id]
 * and events integration tests for the rationale) to prove `generateImageContract`
 * reaches `apiKeyAuth` and body validation: a key lacking `ai:generate` is rejected 403
 * and a malformed body 422, both before any billable generation is enqueued; a key
 * holding the scope, and JWT callers, pass through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const {
  mockValidate,
  mockUserFindById,
  mockRateLimit,
  mockGetOrCreateSession,
  mockInvoke,
  mockResolveImagePrompt,
  mockGetRecentHistory,
  mockAssertUrlAllowed,
  mockFindCallbackSigningSecret,
  mockArmCallback,
  mockFindCallbackById,
  mockClaimCallbackDispatch,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockUserFindById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGetOrCreateSession: vi.fn(),
  mockInvoke: vi.fn(),
  mockResolveImagePrompt: vi.fn(),
  mockGetRecentHistory: vi.fn(),
  mockAssertUrlAllowed: vi.fn(),
  mockFindCallbackSigningSecret: vi.fn(),
  mockArmCallback: vi.fn(),
  mockFindCallbackById: vi.fn(),
  mockClaimCallbackDispatch: vi.fn(),
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
  // Keep the real (pure) extractApiKeyFromHeaders - apiKeyAuth imports it now; only
  // checkApiKeyRateLimit is stubbed.
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
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
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockUserFindById(...a) }),
    questRepository: {
      ...(actual.questRepository as object),
      getMostRecentChatHistory: (...a: unknown[]) => mockGetRecentHistory(...a),
      armCallback: (...a: unknown[]) => mockArmCallback(...a),
      findCallbackById: (...a: unknown[]) => mockFindCallbackById(...a),
      // Short-circuits dispatchQuestCallback (called from armGenerationCallback) so it never
      // reaches SQS/sst - dispatch mechanics are covered by dispatchQuestCallback.test.ts.
      claimCallbackDispatch: (...a: unknown[]) => mockClaimCallbackDispatch(...a),
    },
    userApiKeyRepository: {
      ...(actual.userApiKeyRepository as object),
      findCallbackSigningSecret: (...a: unknown[]) => mockFindCallbackSigningSecret(...a),
    },
  };
});

const mockGetGenerationCallbackQueueUrl = vi.fn(
  () => 'https://sqs.example.com/generationCallbackQueue' as string | undefined
);
vi.mock('@server/generationCallback/dispatchQuestCallback', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getGenerationCallbackQueueUrl: () => mockGetGenerationCallbackQueueUrl(),
}));

vi.mock('@server/utils/ssrfProtection', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  assertUrlAllowed: (...a: unknown[]) => mockAssertUrlAllowed(...a),
}));

vi.mock('@server/managers/sessionManager', () => ({
  getOrCreateSession: (...a: unknown[]) => mockGetOrCreateSession(...a),
}));

vi.mock('@server/queueHandlers/imageGeneration', () => ({
  getImageGeneration: () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }),
}));

vi.mock('@server/utils/resolveImagePrompt', () => ({
  resolveImagePrompt: (...a: unknown[]) => mockResolveImagePrompt(...a),
  HISTORY_LOOKBACK: 10,
}));

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

import handler from '../image-generations';
import legacyHandler from '../../ai/generate-image';
import { questRepository } from '@bike4mind/database';
import { ApiKeyScope, ApiKeyStatus, GenerateImageResponseSchema } from '@bike4mind/common';

const VALID_KEY = 'sk-test-valid-key';

function fire({
  apiKey = VALID_KEY as string | null,
  body = { prompt: 'a red bicycle on a white background', model: 'gpt-image-1' } as Record<string, unknown>,
}: { apiKey?: string | null; body?: Record<string, unknown> } = {}) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/v1/image-generations',
      body,
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

describe('POST /api/v1/image-generations (integration - contract auth + validation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue({ id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false });
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
    mockGetRecentHistory.mockResolvedValue([]);
    mockResolveImagePrompt.mockResolvedValue({ rewrittenPrompt: 'a red bicycle', intent: 'fresh' });
    mockGetOrCreateSession.mockResolvedValue({
      sessionId: 'sess-1',
      asyncPromises: [],
      session: { id: 'sess-1' },
    });
    mockInvoke.mockResolvedValue({ id: 'quest-1', sessionId: 'sess-1', type: 'message' });
    mockAssertUrlAllowed.mockResolvedValue(undefined);
    mockFindCallbackSigningSecret.mockResolvedValue(null);
    mockClaimCallbackDispatch.mockResolvedValue(null);
    mockArmCallback.mockResolvedValue(undefined);
    mockFindCallbackById.mockResolvedValue(null);
  });

  it('rejects a key lacking ai:generate (403) before enqueuing generation', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('accepts a key with ai:generate (200) and enqueues generation', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ quest: { id: 'quest-1' } });
    expect(GenerateImageResponseSchema.safeParse(res._getJSONData()).success).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  describe('referenceImageFabFileIds', () => {
    const REFS = ['ref-1', 'ref-2'];

    it('accepts reference images for a gpt-image model (200)', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      const { req, res } = fire({
        body: { prompt: 'a red bicycle', model: 'gpt-image-1', referenceImageFabFileIds: REFS },
      });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.objectContaining({ referenceImageFabFileIds: REFS }) })
      );
    });

    it('rejects reference images for a non-gpt-image model (400) before creating a session or enqueuing', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      const { req, res } = fire({
        body: { prompt: 'a red bicycle', model: 'flux-pro-1.1', referenceImageFabFileIds: REFS },
      });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toMatch(/referenceImageFabFileIds.*flux-pro-1\.1/);
      expect(mockGetOrCreateSession).not.toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('accepts a non-gpt-image model with no reference images (200)', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      const { req, res } = fire({
        body: { prompt: 'a red bicycle', model: 'flux-pro-1.1', referenceImageFabFileIds: [] },
      });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects a body that fails the contract schema (422) before enqueuing generation', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = fire({ body: { prompt: 'a red bicycle' } });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData().error).toMatch(/model/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('ignores a caller-sent intent/promptEnhancement: both come from the prompt resolver', async () => {
    const { req, res } = fire({
      apiKey: null,
      body: {
        prompt: 'a red bicycle on a white background',
        model: 'gpt-image-1',
        intent: 'continuation',
        promptEnhancement: { originalPrompt: 'x', enhancedPrompt: 'y', promptWasEnhanced: true },
      },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          intent: 'fresh',
          promptEnhancement: expect.objectContaining({ originalPrompt: 'a red bicycle on a white background' }),
        }),
      })
    );
  });

  describe('prompt_resolution', () => {
    const LITERAL_PROMPT = 'a different variant';
    const REWRITTEN_PROMPT = 'a red bicycle on a white background, different variant';

    beforeEach(() => {
      mockGetRecentHistory.mockResolvedValue([{ id: 'prior-quest', images: ['prior.png'] }]);
      mockResolveImagePrompt.mockResolvedValue({ rewrittenPrompt: REWRITTEN_PROMPT, intent: 'continuation' });
    });

    it.each([undefined, 'auto'] as const)('rewrites a continuation when prompt_resolution is %s', async mode => {
      const { req, res } = fire({
        apiKey: null,
        body: { prompt: LITERAL_PROMPT, model: 'gpt-image-1', ...(mode ? { prompt_resolution: mode } : {}) },
      });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toMatchObject({ promptWasEnhanced: true, intent: 'continuation' });
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.objectContaining({ prompt: REWRITTEN_PROMPT }) })
      );
    });

    it('sends a literal prompt unchanged and skips the history resolver', async () => {
      const { req, res } = fire({
        apiKey: null,
        body: { prompt: LITERAL_PROMPT, model: 'gpt-image-1', prompt_resolution: 'literal' },
      });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toMatchObject({
        enhancedPrompt: LITERAL_PROMPT,
        promptWasEnhanced: false,
        intent: 'fresh',
      });
      expect(mockGetRecentHistory).not.toHaveBeenCalled();
      expect(mockResolveImagePrompt).not.toHaveBeenCalled();
      const invokedBody = mockInvoke.mock.calls[0][0].body;
      expect(invokedBody).toMatchObject({
        prompt: LITERAL_PROMPT,
        intent: 'fresh',
        promptEnhancement: { originalPrompt: LITERAL_PROMPT, enhancedPrompt: LITERAL_PROMPT, promptWasEnhanced: false },
      });
      expect(invokedBody).not.toHaveProperty('prompt_resolution');
    });

    it('rejects an unknown prompt_resolution (422) before enqueuing generation', async () => {
      const { req, res } = fire({
        apiKey: null,
        body: { prompt: LITERAL_PROMPT, model: 'gpt-image-1', prompt_resolution: 'verbatim' },
      });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  it('serves the legacy /api/ai/generate-image path with the same handler', () => {
    expect(legacyHandler).toBe(handler);
  });

  it('leaves JWT/browser callers unaffected (200, no api key)', async () => {
    const { req, res } = fire({ apiKey: null });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  describe('callbackUrl', () => {
    const VALID_BODY = { prompt: 'a red bicycle on a white background', model: 'gpt-image-1' };

    it('rejects a callbackUrl from a JWT caller (400) before enqueuing - no per-key signing secret to arm', async () => {
      const { req, res } = fire({ apiKey: null, body: { ...VALID_BODY, callbackUrl: 'https://example.com/hook' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toMatch(/api key/i);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('rejects a non-https callbackUrl (422) before enqueuing', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      const { req, res } = fire({ body: { ...VALID_BODY, callbackUrl: 'http://example.com/hook' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(res._getJSONData().error).toMatch(/callbackUrl|https/i);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('rejects an API-key callbackUrl with 400 on a deployment with no callback queue', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      mockGetGenerationCallbackQueueUrl.mockReturnValueOnce(undefined);
      const { req, res } = fire({ body: { ...VALID_BODY, callbackUrl: 'https://example.com/hook' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toMatch(/not supported on this deployment/);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('rejects an API-key caller whose key has no callback signing secret (400) before enqueuing', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      mockFindCallbackSigningSecret.mockResolvedValue(null);
      const { req, res } = fire({ body: { ...VALID_BODY, callbackUrl: 'https://example.com/hook' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toMatch(/\/api\/user-api-keys\/k1\/callback-secret/);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('arms a pending callback on the quest for an API-key caller with a signing secret (200)', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      mockFindCallbackSigningSecret.mockResolvedValue({
        secret: 'whsec_test',
        userId: 'user-1',
        status: ApiKeyStatus.ACTIVE,
      });
      mockArmCallback.mockImplementation(async (_questId: string, target: { url: string; apiKeyId: string }) => {
        mockFindCallbackById.mockResolvedValue({ ...target, state: 'pending' });
      });
      const { req, res } = fire({ body: { ...VALID_BODY, callbackUrl: 'https://example.com/hook' } });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(mockArmCallback).toHaveBeenCalledWith('quest-1', { url: 'https://example.com/hook', apiKeyId: 'k1' });
      await expect(questRepository.findCallbackById('quest-1')).resolves.toEqual({
        url: 'https://example.com/hook',
        apiKeyId: 'k1',
        state: 'pending',
      });
    });
  });
});
