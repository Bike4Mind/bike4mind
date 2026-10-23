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
  mockOrgFindById,
  mockOrgFindAccessibleById,
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
  mockOrgFindById: vi.fn(),
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

vi.mock('@server/utils/apiKeyTrust', () => ({
  applyUntrustedRateLimit: async (_owner: unknown, key: { rateLimit: unknown }) => key.rateLimit,
}));
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
    organizationRepository: {
      ...(actual.organizationRepository as object),
      findById: (...a: unknown[]) => mockOrgFindById(...a),
      shareable: {
        ...((actual.organizationRepository as { shareable?: object })?.shareable ?? {}),
        findAccessibleById: (...a: unknown[]) => mockOrgFindAccessibleById(...a),
      },
    },
  };
});

const mockGetGenerationCallbackQueueUrl = vi.fn(
  () => 'https://sqs.example.com/generationCallbackQueue' as string | undefined
);
vi.mock('@bike4mind/server-utils/generationCallback/dispatchQuestCallback', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getGenerationCallbackQueueUrl: () => mockGetGenerationCallbackQueueUrl(),
}));

vi.mock('@bike4mind/server-utils/utils/ssrfProtection', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  assertUrlAllowed: (...a: unknown[]) => mockAssertUrlAllowed(...a),
}));

vi.mock('@server/managers/sessionManager', () => ({
  getOrCreateSession: (...a: unknown[]) => mockGetOrCreateSession(...a),
}));

vi.mock('@server/imageGenerations/imageGeneration', () => ({
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
import { ImageGenerationService } from '@bike4mind/services/llm';
import { ApiKeyScope, ApiKeyStatus, CreditHolderType, GenerateImageResponseSchema } from '@bike4mind/common';

const VALID_KEY = 'sk-test-valid-key';
const USER = { id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false };
const HOME_ORG = 'c'.repeat(24);

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

function validateWithScopes(
  scopes: ApiKeyScope[] | string[],
  billing: { billingOwnerType?: CreditHolderType; organizationId?: string } = {}
) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    ...billing,
  });
}

describe('POST /api/v1/image-generations (integration - contract auth + validation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue(USER);
    mockOrgFindById.mockImplementation(async (id: string) => ({ id, userId: 'owner', users: [{ userId: 'user-1' }] }));
    mockOrgFindAccessibleById.mockImplementation(async (_user: unknown, id: string) =>
      id === HOME_ORG ? { id } : null
    );
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

  it('strips server-owned fields from the returned session', async () => {
    mockGetOrCreateSession.mockResolvedValue({
      sessionId: 'sess-1',
      asyncPromises: [],
      session: {
        id: 'sess-1',
        systemPromptText: 'secret prompt',
        preauthorizedLakeIds: ['lake-1'],
        origin: { channel: 'api', apiKeyId: 'k1' },
      },
    });
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    const { session } = res._getJSONData();
    expect(session).toMatchObject({ id: 'sess-1', origin: { channel: 'api' } });
    expect(session).not.toHaveProperty('systemPromptText');
    expect(session).not.toHaveProperty('preauthorizedLakeIds');
    expect(session.origin).not.toHaveProperty('apiKeyId');
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

  describe('billing target (API key)', () => {
    const KEY_ORG = 'd'.repeat(24);
    const OTHER_ORG = 'b'.repeat(24);
    const HOME_ORG = 'c'.repeat(24);
    const base = { prompt: 'a red bicycle', model: 'gpt-image-1' };
    const orgKey = () =>
      validateWithScopes([ApiKeyScope.AI_GENERATE], {
        billingOwnerType: CreditHolderType.Organization,
        organizationId: KEY_ORG,
      });
    const billedOrg = () => mockInvoke.mock.calls[0][0].body.organizationId;

    it('bills the key org when the body names none', async () => {
      orgKey();
      const { req, res } = fire({ body: base });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(billedOrg()).toBe(KEY_ORG);
    });

    it('bills the key org when the body names the same org', async () => {
      orgKey();
      const { req, res } = fire({ body: { ...base, organizationId: KEY_ORG } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(billedOrg()).toBe(KEY_ORG);
    });

    it.each([
      ['another org', OTHER_ORG],
      ['null (personal)', null],
    ])('refuses %s on an org-billed key (403) before enqueuing', async (_label, orgId) => {
      orgKey();
      const { req, res } = fire({ body: { ...base, organizationId: orgId } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData()).toMatchObject({ errorCode: 'billing_organization_mismatch' });
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockGetOrCreateSession).not.toHaveBeenCalled();
    });

    it('refuses an org-billed key whose org no longer exists (400) before enqueuing', async () => {
      orgKey();
      mockOrgFindById.mockResolvedValue(null);
      const { req, res } = fire({ body: base });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockGetOrCreateSession).not.toHaveBeenCalled();
    });

    it('keeps a personal key on the home org when the body names none', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      mockUserFindById.mockResolvedValue({ ...USER, organizationId: HOME_ORG });
      const { req, res } = fire({ body: base });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(billedOrg()).toBe(HOME_ORG);
      expect(mockOrgFindById).not.toHaveBeenCalled();
    });

    it('keeps a personal key on the org the body names', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      const { req, res } = fire({ body: { ...base, organizationId: HOME_ORG } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(billedOrg()).toBe(HOME_ORG);
    });

    it('keeps a session caller on the org the body names', async () => {
      const { req, res } = fire({ apiKey: null, body: { ...base, organizationId: HOME_ORG } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(billedOrg()).toBe(HOME_ORG);
      expect(mockOrgFindById).not.toHaveBeenCalled();
    });

    it.each(['', '   '])('rejects a blank organizationId %j (422) instead of billing personal', async orgId => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      const { req, res } = fire({ body: { ...base, organizationId: orgId } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe('organization_id (the snake_case alias)', () => {
    const base = { prompt: 'a red bicycle', model: 'gpt-image-1' };
    const billedOrg = () => mockInvoke.mock.calls[0][0].body.organizationId;
    const withHomeOrg = (req: { user?: Record<string, unknown> }) => {
      req.user = { ...JWT_USER, organizationId: HOME_ORG };
    };

    it('resolves organization_id like organizationId', async () => {
      const { req, res } = fire({ apiKey: null, body: { ...base, organization_id: HOME_ORG } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(billedOrg()).toBe(HOME_ORG);
    });

    it('bills the personal account for organization_id: null, without a home-org fallback', async () => {
      const { req, res } = fire({ apiKey: null, body: { ...base, organization_id: null } });
      withHomeOrg(req);
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(billedOrg()).toBeNull();
      expect(mockOrgFindAccessibleById).not.toHaveBeenCalled();
    });

    it('falls back to the home org when the body names none', async () => {
      const { req, res } = fire({ apiKey: null, body: base });
      withHomeOrg(req);
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(billedOrg()).toBe(HOME_ORG);
    });

    it('rejects an organization_id the caller cannot access (403) before enqueuing', async () => {
      const FOREIGN_ORG = 'b'.repeat(24);
      const { req, res } = fire({ apiKey: null, body: { ...base, organization_id: FOREIGN_ORG } });
      withHomeOrg(req);
      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
      expect(mockOrgFindAccessibleById).toHaveBeenCalledWith(expect.anything(), FOREIGN_ORG);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('accepts both keys when they agree', async () => {
      const { req, res } = fire({ apiKey: null, body: { ...base, organizationId: null, organization_id: null } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(billedOrg()).toBeNull();
    });

    it.each([
      ['organizationId names one org and organization_id another', { organizationId: HOME_ORG, organization_id: null }],
      ['the conflict points the other way', { organizationId: null, organization_id: HOME_ORG }],
    ])('rejects a disagreement (422) before any session or quest: %s', async (_label, orgs) => {
      const { req, res } = fire({ apiKey: null, body: { ...base, ...orgs } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(res._getJSONData().error).toMatch(/organizationId and organization_id disagree/);
      expect(mockGetOrCreateSession).not.toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it.each(['', '   '])('rejects a blank organization_id %j (422) instead of billing personally', async blank => {
      const { req, res } = fire({ apiKey: null, body: { ...base, organization_id: blank } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it.each([
      'organizationID',
      'billing_org_id',
      'orgId',
      'billingOrganizationId',
      'billingAccountId',
      'billed_organization_id',
      'payerOrgId',
      'payer_org_id',
    ])('rejects the unknown billing-shaped key %s (422) before any session, resolver or quest', async key => {
      const { req, res } = fire({ apiKey: null, body: { ...base, [key]: 'orgA' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(res._getJSONData().error).toContain(key);
      expect(mockGetOrCreateSession).not.toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('route -> invoke -> queued SQS body: organization_id null stays null, omitted becomes the home org', async () => {
      const queued: Array<Record<string, unknown>> = [];
      const service = new ImageGenerationService({
        db: {
          sessions: { findById: vi.fn(async () => ({ id: 'sess-1' })) },
          quests: {
            getMostRecentChatHistory: vi.fn(async () => []),
            create: vi.fn(async (q: Record<string, unknown>) => ({ id: 'quest-1', ...q })),
          },
        },
        startImageGenerationProcess: async queueBody => {
          queued.push(JSON.parse(JSON.stringify(queueBody)));
        },
      } as unknown as ConstructorParameters<typeof ImageGenerationService>[0]);
      mockInvoke.mockImplementation((args: Parameters<typeof service.invoke>[0]) => service.invoke(args));

      const a = fire({ apiKey: null, body: { ...base, organization_id: null } });
      withHomeOrg(a.req);
      await handler(a.req, a.res);
      expect(a.res._getStatusCode()).toBe(200);
      // process() bills `organizationId ? org : personal`, so null here is the personal ledger.
      expect(queued[0]).toHaveProperty('organizationId', null);

      const b = fire({ apiKey: null, body: base });
      withHomeOrg(b.req);
      await handler(b.req, b.res);
      expect(queued[1]).toHaveProperty('organizationId', HOME_ORG);
    });
  });
});
