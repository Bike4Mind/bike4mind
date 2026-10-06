// @vitest-environment node
/**
 * Integration test for POST /api/v1/video-generations (and its legacy alias
 * /api/ai/generate-video).
 *
 * Mirrors image-edits.integration.test.ts: drives the real next-connect chain
 * `nextRouteForContract` assembles to prove `generateVideoContract` reaches `apiKeyAuth` and
 * body validation - a key lacking `ai:generate` is rejected 403 and a malformed body 422,
 * both before any billable generation is enqueued; a key holding the scope, and JWT callers,
 * pass through. Also covers `callbackUrl`: a JWT caller has no per-key signing secret to
 * arm one with, so it is rejected 400 before any work is queued.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const {
  mockValidate,
  mockUserFindById,
  mockRateLimit,
  mockInvoke,
  mockGetOrCreateSession,
  mockResolveBillingOrgId,
  mockAssertUrlAllowed,
  mockFindCallbackSigningSecret,
  mockArmCallback,
  mockFindCallbackById,
  mockClaimCallbackDispatch,
  mockOrgFindAccessibleById,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockUserFindById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockInvoke: vi.fn(),
  mockGetOrCreateSession: vi.fn(),
  mockResolveBillingOrgId: vi.fn(),
  mockAssertUrlAllowed: vi.fn(),
  mockFindCallbackSigningSecret: vi.fn(),
  mockArmCallback: vi.fn(),
  mockFindCallbackById: vi.fn(),
  mockClaimCallbackDispatch: vi.fn(),
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
vi.mock('@server/utils/orgAccess', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  resolveBillingOrgId: (...a: unknown[]) => mockResolveBillingOrgId(...a),
}));

vi.mock('@server/queueHandlers/videoGeneration', () => ({
  getVideoGeneration: () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }),
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

import handler from '../video-generations';
import legacyHandler from '../../ai/generate-video';
import { questRepository } from '@bike4mind/database';
import { ApiKeyScope, ApiKeyStatus, VideoQuestSchema, NotFoundError } from '@bike4mind/common';

const VALID_KEY = 'sk-test-valid-key';

function fire({
  apiKey = VALID_KEY as string | null,
  body = {},
}: { apiKey?: string | null; body?: Record<string, unknown> } = {}) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/v1/video-generations',
      body: {
        prompt: 'a drone shot over a foggy pine forest at sunrise',
        model: 'sora-2',
        seconds: 4,
        sessionId: 's1',
        ...body,
      },
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

describe('POST /api/v1/video-generations (integration - contract auth + validation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue({ id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false });
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
    mockInvoke.mockResolvedValue({ id: 'quest-1', sessionId: 's1', type: 'message' });
    mockGetOrCreateSession.mockResolvedValue({ session: { id: 's1' }, sessionId: 's1', asyncPromises: [] });
    mockResolveBillingOrgId.mockImplementation(async (_req: unknown, id: string | null | undefined) => id ?? null);
    mockAssertUrlAllowed.mockResolvedValue(undefined);
    mockFindCallbackSigningSecret.mockResolvedValue(null);
    mockClaimCallbackDispatch.mockResolvedValue(null);
    mockArmCallback.mockResolvedValue(undefined);
    mockFindCallbackById.mockResolvedValue(null);
  });

  it('rejects a key lacking ai:generate (403) before enqueuing the generation', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('accepts a key with ai:generate (200) and enqueues the generation', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ quest: { id: 'quest-1' }, session: { id: 's1' } });
    expect(VideoQuestSchema.safeParse(res._getJSONData().quest).success).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('rejects a body that fails the contract schema (422) before enqueuing the generation', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = fire({ body: { prompt: undefined } });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData().error).toMatch(/prompt/);
    expect(mockGetOrCreateSession).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('serves the legacy /api/ai/generate-video path with the same handler', () => {
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
    it('rejects a callbackUrl from a JWT caller (400) before enqueuing - no per-key signing secret to arm', async () => {
      const { req, res } = fire({ apiKey: null, body: { callbackUrl: 'https://example.com/hook' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toMatch(/api key/i);
      expect(mockGetOrCreateSession).not.toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('rejects a non-https callbackUrl (422) before enqueuing', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      const { req, res } = fire({ body: { callbackUrl: 'http://example.com/hook' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(res._getJSONData().error).toMatch(/callbackUrl|https/i);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('rejects an API-key callbackUrl with 400 on a deployment with no callback queue', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      mockGetGenerationCallbackQueueUrl.mockReturnValueOnce(undefined);
      const { req, res } = fire({ body: { callbackUrl: 'https://example.com/hook' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toMatch(/not supported on this deployment/);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('rejects an API-key caller whose key has no callback signing secret (400) before enqueuing', async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      mockFindCallbackSigningSecret.mockResolvedValue(null);
      const { req, res } = fire({ body: { callbackUrl: 'https://example.com/hook' } });
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
      const { req, res } = fire({ body: { callbackUrl: 'https://example.com/hook' } });

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

  describe('caller scoping', () => {
    it('rejects an organizationId the caller is not a member of (403) before enqueuing', async () => {
      // The real resolveBillingOrgId -> resolveActiveOrg chain runs here with only the membership
      // gate stubbed, so this pins the status the route actually returns, not a mocked rejection.
      const { resolveBillingOrgId: realResolveBillingOrgId } =
        await vi.importActual<typeof import('@server/utils/orgAccess')>('@server/utils/orgAccess');
      mockResolveBillingOrgId.mockImplementationOnce(realResolveBillingOrgId);
      mockOrgFindAccessibleById.mockResolvedValueOnce(null);
      const { req, res } = fire({ apiKey: null, body: { organizationId: 'foreign-org' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
      expect(mockOrgFindAccessibleById).toHaveBeenCalledWith(expect.anything(), 'foreign-org');
      expect(mockResolveBillingOrgId).toHaveBeenCalledWith(expect.anything(), 'foreign-org');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('rejects a sessionId the caller cannot write to (404) before enqueuing', async () => {
      mockGetOrCreateSession.mockRejectedValue(new NotFoundError('Session not found'));
      const { req, res } = fire({ apiKey: null, body: { sessionId: 'foreign' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(404);
      expect(mockGetOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'foreign' }));
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });
});
