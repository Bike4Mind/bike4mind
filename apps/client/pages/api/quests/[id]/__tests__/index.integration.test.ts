// @vitest-environment node
/**
 * Integration test for GET /api/quests/[id] scope enforcement.
 *
 * Imports the REAL handler and drives the full next-connect chain that `baseApi`
 * assembles (see events.integration.test.ts for the rationale). Proves the
 * `baseApi({ requiredScopes: [READ_NOTEBOOKS, AI_CHAT, AI_GENERATE] })` wiring
 * reaches `apiKeyAuth` with OR semantics: a key holding none of those scopes is
 * rejected 403 before the handler runs; a key with any one of them (and JWT
 * callers) pass through to a 2xx response. The AI scopes are accepted because
 * quest-read is the documented poll step after POST /api/chat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockFindById, mockRateLimit, mockQuestFindById, mockSessionFindById } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockQuestFindById: vi.fn(),
  mockSessionFindById: vi.fn(),
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
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
    questRepository: {
      ...(actual.questRepository as object),
      findById: (...a: unknown[]) => mockQuestFindById(...a),
    },
    sessionRepository: {
      ...(actual.sessionRepository as object),
      findById: (...a: unknown[]) => mockSessionFindById(...a),
    },
  };
});

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

import handler from '../index';
import { ApiKeyScope } from '@bike4mind/common';

const VALID_KEY = 'sk-test-valid-key';

function fire({ apiKey = VALID_KEY as string | null }: { apiKey?: string | null } = {}) {
  const { req, res } = createMocks(
    {
      method: 'GET',
      url: '/api/quests/quest-1',
      query: { id: 'quest-1' },
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

describe('GET /api/quests/[id] (integration — scope enforcement via real middleware chain)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockReturnValue(
      Promise.resolve({ id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false })
    );
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
    mockQuestFindById.mockResolvedValue({
      id: 'quest-1',
      sessionId: 'sess-1',
      status: 'completed',
      reply: {},
      replies: [],
      promptMeta: {},
    });
    // Session grants access to both the api-key user and the JWT user.
    mockSessionFindById.mockResolvedValue({
      id: 'sess-1',
      userId: 'owner',
      users: [{ userId: 'user-1' }, { userId: 'jwt-user' }],
    });
  });

  it('rejects a key lacking notebooks:read (403)', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(mockQuestFindById).not.toHaveBeenCalled();
  });

  it('accepts a key with notebooks:read (200)', async () => {
    validateWithScopes([ApiKeyScope.READ_NOTEBOOKS]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: 'quest-1', status: 'completed' });
  });

  it('accepts an ai:chat-only key (200) — the chat→poll happy path (OR widening)', async () => {
    validateWithScopes([ApiKeyScope.AI_CHAT]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: 'quest-1', status: 'completed' });
  });

  it('leaves JWT/browser callers unaffected (200, no api key)', async () => {
    const { req, res } = fire({ apiKey: null });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it('derives ready-to-use CDN imageUrls from quest.images basenames', async () => {
    const prev = process.env.NEXT_PUBLIC_CDN_URL;
    process.env.NEXT_PUBLIC_CDN_URL = 'https://cdn.example.com';
    mockQuestFindById.mockResolvedValue({
      id: 'quest-1',
      sessionId: 'sess-1',
      status: 'done',
      reply: {},
      replies: [],
      promptMeta: {},
      images: ['a1b2c3.png', 'doc.xlsx'],
    });
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      images: ['a1b2c3.png', 'doc.xlsx'],
      imageUrls: ['https://cdn.example.com/generated/a1b2c3.png', 'https://cdn.example.com/generated/doc.xlsx'],
    });
    process.env.NEXT_PUBLIC_CDN_URL = prev;
  });

  it('returns empty images/imageUrls when the quest generated nothing', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ images: [], imageUrls: [] });
  });
});
