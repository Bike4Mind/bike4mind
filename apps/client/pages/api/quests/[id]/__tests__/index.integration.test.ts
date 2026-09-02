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

const { mockValidate, mockFindById, mockRateLimit, mockQuestFindById, mockQuestSettle, mockSessionFindById } =
  vi.hoisted(() => ({
    mockValidate: vi.fn(),
    mockFindById: vi.fn(),
    mockRateLimit: vi.fn(),
    mockQuestFindById: vi.fn(),
    mockQuestSettle: vi.fn(),
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
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
    questRepository: {
      ...(actual.questRepository as object),
      findById: (...a: unknown[]) => mockQuestFindById(...a),
      settleIfUnfinished: (...a: unknown[]) => mockQuestSettle(...a),
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
import { QUEST_TIMEOUT_THRESHOLD_MS } from '@server/chatCompletion/questTimeoutRecovery';

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

  it('resolves quest.images basenames into typed CDN file descriptors', async () => {
    const prev = process.env.NEXT_PUBLIC_CDN_URL;
    process.env.NEXT_PUBLIC_CDN_URL = 'https://cdn.example.com';
    mockQuestFindById.mockResolvedValue({
      id: 'quest-1',
      sessionId: 'sess-1',
      status: 'done',
      reply: {},
      replies: [],
      promptMeta: {},
      images: ['a1b2c3.png', 'report.xlsx'],
    });
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    // Raw basenames preserved; files[] carries ready-to-use URLs and flags the non-image .xlsx.
    expect(res._getJSONData()).toMatchObject({
      images: ['a1b2c3.png', 'report.xlsx'],
      files: [
        { name: 'a1b2c3.png', url: 'https://cdn.example.com/generated/a1b2c3.png', isImage: true },
        { name: 'report.xlsx', url: 'https://cdn.example.com/generated/report.xlsx', isImage: false },
      ],
    });
    process.env.NEXT_PUBLIC_CDN_URL = prev;
  });

  it('returns empty images/files when the quest generated nothing', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = fire();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ images: [], files: [] });
  });

  describe('toolPayloads (structured tool output for programmatic callers)', () => {
    const PROBLEM = { name: 'shop', jobs: [], machines: [] };

    it('returns the structured payload ALONGSIDE the unchanged prose reply', async () => {
      mockQuestFindById.mockResolvedValue({
        id: 'quest-1',
        sessionId: 'sess-1',
        status: 'completed',
        reply: 'Scheduled 3 jobs across 2 machines.',
        replies: ['Scheduled 3 jobs across 2 machines.'],
        promptMeta: {},
        uiSideEffects: [{ type: 'populateProblem', payload: PROBLEM }],
      });
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      const body = res._getJSONData();
      expect(body.reply).toBe('Scheduled 3 jobs across 2 machines.');
      expect(body.toolPayloads).toEqual([{ type: 'populateProblem', payload: PROBLEM }]);
    });

    it('returns an empty array when the turn fired no structured tool', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getJSONData().toolPayloads).toEqual([]);
    });

    it('publishes only type and payload, so a Mongoose subdocument _id never leaks', async () => {
      mockQuestFindById.mockResolvedValue({
        id: 'quest-1',
        sessionId: 'sess-1',
        status: 'completed',
        reply: {},
        replies: [],
        promptMeta: {},
        uiSideEffects: [{ _id: '507f1f77bcf86cd799439011', type: 'populateProblem', payload: PROBLEM }],
      });
      validateWithScopes([ApiKeyScope.AI_CHAT]);
      const { req, res } = fire();
      await handler(req, res);
      expect(Object.keys(res._getJSONData().toolPayloads[0])).toEqual(['type', 'payload']);
    });

    it('serves them to a sharee too - the client already dispatches them off loaded quests', async () => {
      mockQuestFindById.mockResolvedValue({
        id: 'quest-1',
        sessionId: 'sess-1',
        status: 'completed',
        reply: {},
        replies: [],
        promptMeta: {},
        uiSideEffects: [{ type: 'populateProblem', payload: PROBLEM }],
      });
      // jwt-user is in session.users but is not session.userId, i.e. a share holder.
      const { req, res } = fire({ apiKey: null });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().toolPayloads).toEqual([{ type: 'populateProblem', payload: PROBLEM }]);
    });
  });

  describe('read-time timeout recovery (headless API clients)', () => {
    const staleDate = new Date(Date.now() - QUEST_TIMEOUT_THRESHOLD_MS - 5_000).toISOString();

    const stuckQuest = (overrides: Record<string, unknown> = {}) => ({
      id: 'quest-1',
      sessionId: 'sess-1',
      status: 'running',
      reply: null,
      replies: [],
      images: [],
      promptMeta: {},
      updatedAt: staleDate,
      ...overrides,
    });

    /** The JWT caller owns the session - recovery writes are owner-only. */
    const ownedByJwtUser = () => mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });

    beforeEach(() => {
      mockQuestSettle.mockResolvedValue(true);
    });

    it('recovers a stuck quest on GET and returns terminal status', async () => {
      mockQuestFindById.mockResolvedValue(stuckQuest());
      ownedByJwtUser();

      const { req, res } = fire({ apiKey: null });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      const body = res._getJSONData();
      expect(body.status).toBe('done');
      // `type` is what lets a headless client tell a recovered timeout from a real success.
      expect(body.type).toBe('error');
      expect(mockQuestSettle).toHaveBeenCalledWith(
        'quest-1',
        expect.objectContaining({ status: 'done', type: 'error' })
      );
    });

    it('preserves content on a stuck quest that has replies', async () => {
      mockQuestFindById.mockResolvedValue(stuckQuest({ reply: 'partial answer', replies: ['partial answer'] }));
      ownedByJwtUser();

      const { req, res } = fire({ apiKey: null });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().status).toBe('done');
      // No error type when content exists
      expect(mockQuestSettle).toHaveBeenCalledWith('quest-1', { status: 'done' });
    });

    it('does not recover a fresh running quest (heartbeat still alive)', async () => {
      mockQuestFindById.mockResolvedValue(stuckQuest({ updatedAt: new Date().toISOString() }));
      ownedByJwtUser();

      const { req, res } = fire({ apiKey: null });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().status).toBe('running');
      expect(mockQuestSettle).not.toHaveBeenCalled();
    });

    it('does not re-recover an already-terminal quest', async () => {
      mockQuestFindById.mockResolvedValue(stuckQuest({ status: 'done', reply: 'complete', replies: ['complete'] }));
      ownedByJwtUser();

      const { req, res } = fire({ apiKey: null });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().status).toBe('done');
      expect(mockQuestSettle).not.toHaveBeenCalled();
    });

    it('works for API-key callers (the actual bug: headless API clients never got recovery)', async () => {
      validateWithScopes([ApiKeyScope.AI_CHAT]); // resolves to userId 'user-1'
      mockQuestFindById.mockResolvedValue(stuckQuest());
      mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'user-1', users: [] });

      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().status).toBe('done');
      expect(mockQuestSettle).toHaveBeenCalled();
    });

    it('returns the quest unchanged when the recovery write loses the race', async () => {
      mockQuestFindById.mockResolvedValue(stuckQuest());
      ownedByJwtUser();
      // The compare-and-set matched nothing: the run committed its real answer in the gap
      // between the read and this write, and must keep it.
      mockQuestSettle.mockResolvedValue(false);

      const { req, res } = fire({ apiKey: null });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().status).toBe('running');
    });

    it('still answers with the quest when the recovery write throws', async () => {
      mockQuestFindById.mockResolvedValue(stuckQuest());
      ownedByJwtUser();
      // Writes fail for reasons reads do not (a primary stepdown, a write-concern timeout).
      // Turning a GET that can still answer into a 500 is worse than answering 'running'.
      mockQuestSettle.mockRejectedValue(new Error('not primary'));

      const { req, res } = fire({ apiKey: null });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().status).toBe('running');
    });

    it('does not let a sharee read write a terminal status onto the owner quest', async () => {
      mockQuestFindById.mockResolvedValue(stuckQuest());
      // jwt-user is a sharee here, not session.userId. Recovery for a quest only sharees ever
      // poll is the sweep cron's job, not a viewer's.
      mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'owner', users: [{ userId: 'jwt-user' }] });

      const { req, res } = fire({ apiKey: null });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().status).toBe('running');
      expect(mockQuestSettle).not.toHaveBeenCalled();
    });
  });

  describe('functionCalls redaction for non-owner viewers', () => {
    const questWithFunctionCalls = () => ({
      id: 'quest-1',
      sessionId: 'sess-1',
      status: 'completed',
      reply: {},
      replies: [],
      promptMeta: {
        functionCalls: [
          { name: 'web_search', parameters: {}, id: 'call_1', returnValue: 'PRIVATE TOOL OUTPUT', success: true },
        ],
      },
    });

    it('strips returnValue for a sharee (jwt-user is not session.userId)', async () => {
      mockQuestFindById.mockResolvedValue(questWithFunctionCalls());
      const { req, res } = fire({ apiKey: null }); // JWT_USER.id === 'jwt-user', a sharee not the owner
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      const body = res._getJSONData();
      // Whole-response, not field-scoped: guards against the leak reappearing through a sibling
      // field (e.g. executionTracking) that also reads off the unredacted quest.promptMeta.
      expect(JSON.stringify(body)).not.toContain('PRIVATE TOOL OUTPUT');
      expect(body.promptMeta.functionCalls[0]).toMatchObject({ name: 'web_search', id: 'call_1', success: true });
    });

    it('strips returnValue for a sharee polling via an API key (not just JWT/browser callers)', async () => {
      validateWithScopes([ApiKeyScope.READ_NOTEBOOKS]); // resolves to userId 'user-1', a sharee per beforeEach
      mockQuestFindById.mockResolvedValue(questWithFunctionCalls());
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      const body = res._getJSONData();
      expect(JSON.stringify(body)).not.toContain('PRIVATE TOOL OUTPUT');
    });

    it('leaves returnValue untouched for the session owner', async () => {
      mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'jwt-user', users: [] });
      mockQuestFindById.mockResolvedValue(questWithFunctionCalls());
      const { req, res } = fire({ apiKey: null });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      const body = res._getJSONData();
      expect(JSON.stringify(body.promptMeta.functionCalls)).toContain('PRIVATE TOOL OUTPUT');
    });
  });
});
