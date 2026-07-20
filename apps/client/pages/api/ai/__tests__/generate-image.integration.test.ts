// @vitest-environment node
/**
 * Integration test for POST /api/ai/generate-image scope enforcement.
 *
 * Drives the real next-connect chain `baseApi` assembles (see quests/[id] and
 * events integration tests for the rationale) to prove the
 * `baseApi({ requiredScopes: [AI_GENERATE] })` wiring reaches `apiKeyAuth`: a
 * key lacking `ai:generate` is rejected 403 before the handler runs (and before
 * any billable generation is enqueued); a key holding it, and JWT callers, pass
 * through. This guards a billable + access-control surface against an accidental
 * future removal of `requiredScopes`.
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
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockUserFindById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGetOrCreateSession: vi.fn(),
  mockInvoke: vi.fn(),
  mockResolveImagePrompt: vi.fn(),
  mockGetRecentHistory: vi.fn(),
}));

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit-Minute': '60',
  'X-RateLimit-Remaining-Minute': '59',
  'X-RateLimit-Reset-Minute': '0',
  'X-RateLimit-Limit-Day': '1000',
  'X-RateLimit-Remaining-Day': '999',
  'X-RateLimit-Reset-Day': '0',
};

vi.mock('@server/utils/apiKeyRateLimitCheck', () => ({
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
    },
  };
});

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

import handler from '../generate-image';
import { ApiKeyScope } from '@bike4mind/common';

const VALID_KEY = 'sk-test-valid-key';

function fire({ apiKey = VALID_KEY as string | null }: { apiKey?: string | null } = {}) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/ai/generate-image',
      body: { prompt: 'a red bicycle on a white background' },
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

describe('POST /api/ai/generate-image (integration — ai:generate scope enforcement)', () => {
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
    mockInvoke.mockResolvedValue({ id: 'quest-1', status: 'pending' });
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
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('leaves JWT/browser callers unaffected (200, no api key)', async () => {
    const { req, res } = fire({ apiKey: null });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});
