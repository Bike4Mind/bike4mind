// @vitest-environment node
/**
 * DELETE /api/sessions/bulk - the second live entry point into sessionService.deleteSession.
 *
 * What is pinned here is the transaction boundary, not the bulk semantics: deleteSession rewrites
 * grant rows on every file a session touched before it tombstones anything, so each individual
 * delete has to be all-or-nothing. It is per session rather than around the loop because bulk is
 * best-effort - one failure must not roll back the sessions already deleted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockFindById, mockDeleteSession, mockLogEvent, mockWithTransaction, mockValidate, mockRateLimit } = vi.hoisted(
  () => ({
    mockFindById: vi.fn(),
    mockDeleteSession: vi.fn(),
    mockLogEvent: vi.fn(),
    mockWithTransaction: vi.fn(),
    mockValidate: vi.fn(),
    mockRateLimit: vi.fn(),
  })
);

const mockFav = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn() }));
const mockTag = vi.hoisted(() => ({
  update: vi.fn(),
  findUpdatable: vi.fn(),
  findTaggable: vi.fn(),
  credits: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@server/sessions/sessionUpdateAdapters', () => ({ buildSessionUpdateAdapters: () => ({}) }));
vi.mock('@server/utils/sessionOperationalCreditPreflight', () => ({
  assertSessionOperationalCredits: (...a: unknown[]) => mockTag.credits(...a),
}));
vi.mock('@server/utils/eventBus', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  SessionEvents: { Tag: { publish: (...a: unknown[]) => mockTag.publish(...a) } },
}));
// Session is a plain stub here, which CASL's ofType cannot read a model name from.
vi.mock('@casl/mongoose', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  accessibleBy: () => ({ ofType: () => ({}) }),
}));
vi.mock('@bike4mind/database/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, Session: { find: (...a: unknown[]) => mockTag.findTaggable(...a) } };
});

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit-Minute': '60',
  'X-RateLimit-Remaining-Minute': '59',
  'X-RateLimit-Reset-Minute': '0',
  'X-RateLimit-Limit-Day': '1000',
  'X-RateLimit-Remaining-Day': '999',
  'X-RateLimit-Reset-Day': '0',
};

vi.mock('@server/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
    sessionService: {
      ...(actual.sessionService as object),
      deleteSession: (...a: unknown[]) => mockDeleteSession(...a),
      addFavorite: (...a: unknown[]) => mockFav.add(...a),
      deleteFavorite: (...a: unknown[]) => mockFav.remove(...a),
      updateSession: (...a: unknown[]) => mockTag.update(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    withTransaction: (...a: unknown[]) => mockWithTransaction(...a),
    sessionRepository: {
      ...(actual.sessionRepository as object),
      shareable: {
        findAllUpdateAccessByIds: (...a: unknown[]) => mockTag.findUpdatable(...a),
        findUpdateAccessById: async (user: unknown, id: string) => {
          const sessions: { id: string; tags: { name: string; strength: number }[] }[] = await mockTag.findUpdatable(
            user,
            [id]
          );
          return sessions.find(session => session.id === id) ?? null;
        },
      },
    },
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
  };
});

import handler from '../bulk';
import { SessionEvents } from '@bike4mind/common';

// Authenticates by API key for the same reason the /api/sessions/[id] suite does: apiKeyAuth sets
// req.user and the real auth middleware then skips passport, so no auth stub is needed.
function fire(sessionIds: string[]) {
  return fireWith('DELETE', { sessionIds });
}

function fireWith(method: 'DELETE' | 'POST', body: unknown) {
  const payload = JSON.stringify(body);
  const { req, res } = createMocks(
    {
      method,
      url: '/api/sessions/bulk',
      headers: {
        'x-api-key': 'sk-test-valid-key',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      },
      // any: deliberately malformed bodies are part of what the POST cases send.
      body: body as any,
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWithTransaction.mockImplementation(async (fn: (s: unknown) => unknown) => fn(undefined));
  // apiKeyAuth calls logEvent(...).catch(...), so the stub has to be thenable.
  mockLogEvent.mockResolvedValue(undefined);
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes: [],
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
  mockFindById.mockResolvedValue({
    id: 'user-1',
    _id: 'user-1',
    isBanned: false,
    disputePending: false,
    aupAcceptedVersion: 'grandfathered',
  });
  mockDeleteSession.mockResolvedValue({ id: 'other-session' });
  mockFav.add.mockResolvedValue({});
  mockFav.remove.mockResolvedValue({});
  mockTag.credits.mockResolvedValue(undefined);
  mockTag.publish.mockImplementation(async ({ sessionId }: { sessionId: string }) => `job-${sessionId}`);
});

function withScopes(scopes: string[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

describe('DELETE /api/sessions/bulk', () => {
  it('runs each delete inside its own transaction', async () => {
    // Asserting the call count alone would pass on a route that opened a transaction and then ran
    // the cascade outside it, which is the shape that leaves files half-rewritten, so the service
    // records whether it was reached from within the callback.
    let inTransaction = false;
    const sawTransaction: boolean[] = [];
    mockWithTransaction.mockImplementation(async (fn: (s: unknown) => unknown) => {
      inTransaction = true;
      try {
        return await fn(undefined);
      } finally {
        inTransaction = false;
      }
    });
    mockDeleteSession.mockImplementation(async () => {
      sawTransaction.push(inTransaction);
      return { id: 'other-session' };
    });

    const { req, res } = fire(['s1', 's2']);
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockWithTransaction).toHaveBeenCalledTimes(2);
    expect(sawTransaction).toEqual([true, true]);
    expect(res._getJSONData()).toEqual({ deletedCount: 2, newLastNotebookId: 'other-session' });
  });

  it('keeps going after one session fails and does not count it', async () => {
    mockDeleteSession
      .mockRejectedValueOnce(new Error('ConcurrencyConflictError'))
      .mockResolvedValueOnce({ id: 'other-session' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { req, res } = fire(['s1', 's2']);
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockDeleteSession).toHaveBeenCalledTimes(2);
    // The rolled-back session must not be reported as deleted, and must not be logged as one.
    expect(res._getJSONData()).toEqual({ deletedCount: 1, newLastNotebookId: 'other-session' });
    // apiKeyAuth logs a key-usage event of its own, so count the delete events specifically.
    const deleteEvents = mockLogEvent.mock.calls.filter(
      ([event]: [{ type?: string }]) => event?.type === SessionEvents.DELETE_SESSION
    );
    expect(deleteEvents).toHaveLength(1);
  });

  it('rejects an empty request without touching the service', async () => {
    const { req, res } = fire([]);
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockDeleteSession).not.toHaveBeenCalled();
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/bulk - favorite', () => {
  const id = (n: number) => `65a0000000000000000000${String(n).padStart(2, '0')}`;

  it('adds and removes favorites in one request and reports each result', async () => {
    const { req, res } = fireWith('POST', { action: 'favorite', add: [id(1), id(2)], remove: [id(3)] });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFav.add).toHaveBeenCalledTimes(2);
    expect(mockFav.remove).toHaveBeenCalledTimes(1);
    expect(mockFav.add.mock.calls[0][1]).toEqual({ sessionId: id(1) });
    expect(res._getJSONData()).toEqual({
      okCount: 3,
      results: [
        { id: id(1), ok: true },
        { id: id(2), ok: true },
        { id: id(3), ok: true },
      ],
    });
  });

  it('keeps bulk favorites open to a key without notebooks:write', async () => {
    withScopes([]);
    const { req, res } = fireWith('POST', { action: 'favorite', add: [id(1)], remove: [] });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFav.add).toHaveBeenCalledTimes(1);
  });

  it('fails an inaccessible or malformed id without failing the request', async () => {
    mockFav.add.mockRejectedValueOnce(new Error('Session not found or not accessible'));
    const { req, res } = fireWith('POST', { action: 'favorite', add: [id(1), 'not-an-id', id(2)], remove: [] });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockFav.add).toHaveBeenCalledTimes(2);
    expect(res._getJSONData()).toEqual({
      okCount: 1,
      results: [
        { id: id(1), ok: false, error: 'Update failed' },
        { id: 'not-an-id', ok: false, error: 'Invalid session id' },
        { id: id(2), ok: true },
      ],
    });
  });

  it('de-duplicates ids', async () => {
    const { req, res } = fireWith('POST', { action: 'favorite', add: [id(1), id(1)], remove: [] });
    await handler(req, res);

    expect(mockFav.add).toHaveBeenCalledTimes(1);
    expect(res._getJSONData().okCount).toBe(1);
  });

  it.each([
    ['empty lists', { action: 'favorite', add: [], remove: [] }],
    ['a non-array', { action: 'favorite', add: id(1), remove: [] }],
    ['an unknown action', { action: 'explode', add: [id(1)], remove: [] }],
    ['an id in both lists', { action: 'favorite', add: [id(1)], remove: [id(1)] }],
    ['more ids than the cap', { action: 'favorite', add: Array.from({ length: 101 }, (_, i) => `x${i}`), remove: [] }],
    [
      'a combined total over the cap',
      {
        action: 'favorite',
        add: Array.from({ length: 60 }, (_, i) => `a${i}`),
        remove: Array.from({ length: 60 }, (_, i) => `r${i}`),
      },
    ],
  ])('rejects %s with 400 before touching the service', async (_, body) => {
    const { req, res } = fireWith('POST', body);
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockFav.add).not.toHaveBeenCalled();
    expect(mockFav.remove).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/bulk - tags', () => {
  const id = (n: number) => `65a0000000000000000000${String(n).padStart(2, '0')}`;

  beforeEach(() => withScopes(['notebooks:write']));

  it('merges new tags into the stored ones and skips names already present', async () => {
    mockTag.findUpdatable.mockResolvedValue([
      { id: id(1), tags: [{ name: 'keep', strength: 0.4 }] },
      { id: id(2), tags: [] },
    ]);
    mockTag.update.mockImplementation(async (_u: unknown, p: { id: string }) => ({ id: p.id, name: 'n' }));

    const { req, res } = fireWith('POST', { action: 'addTags', sessionIds: [id(1), id(2)], tags: [' keep ', 'new'] });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockTag.findUpdatable).toHaveBeenCalledTimes(2);
    expect(mockTag.update.mock.calls.map(c => c[1])).toEqual([
      {
        id: id(1),
        tags: [
          { name: 'keep', strength: 0.4 },
          { name: 'new', strength: 1 },
        ],
      },
      {
        id: id(2),
        tags: [
          { name: 'keep', strength: 1 },
          { name: 'new', strength: 1 },
        ],
      },
    ]);
    expect(res._getJSONData().okCount).toBe(2);
  });

  it('re-reads tags on a transaction retry and logs only the committed write', async () => {
    let inTransaction = false;
    mockTag.findUpdatable
      .mockResolvedValueOnce([{ id: id(1), tags: [{ name: 'original', strength: 0.4 }] }])
      .mockResolvedValueOnce([{ id: id(1), tags: [{ name: 'concurrent', strength: 0.7 }] }]);
    mockTag.update.mockImplementation(async (_user: unknown, parameters: { id: string }) => {
      expect(inTransaction).toBe(true);
      return { id: parameters.id, name: 'Notebook' };
    });
    mockWithTransaction.mockImplementationOnce(async (callback: (session: unknown) => Promise<unknown>) => {
      inTransaction = true;
      try {
        await callback(undefined);
        return await callback(undefined);
      } finally {
        inTransaction = false;
      }
    });
    const { req, res } = fireWith('POST', { action: 'addTags', sessionIds: [id(1)], tags: ['new'] });
    await handler(req, res);

    expect(mockTag.findUpdatable).toHaveBeenCalledTimes(2);
    expect(mockTag.update).toHaveBeenLastCalledWith(
      expect.anything(),
      {
        id: id(1),
        tags: [
          { name: 'concurrent', strength: 0.7 },
          { name: 'new', strength: 1 },
        ],
      },
      expect.anything()
    );
    expect(mockLogEvent.mock.calls.filter(([event]) => event.type === SessionEvents.UPDATE_SESSION)).toHaveLength(1);
    expect(res._getJSONData().okCount).toBe(1);
  });

  it('reports a persisted update as ok when the event log fails', async () => {
    mockTag.findUpdatable.mockResolvedValue([{ id: id(1), tags: [] }]);
    mockTag.update.mockResolvedValue({ id: id(1), name: 'n' });
    mockLogEvent.mockRejectedValue(new Error('analytics down'));

    const { req, res } = fireWith('POST', { action: 'addTags', sessionIds: [id(1)], tags: ['t'] });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().okCount).toBe(1);
    expect(res._getJSONData().results[0]).toMatchObject({ id: id(1), ok: true });
  });

  it('fails an id the caller cannot update without touching it', async () => {
    mockTag.findUpdatable.mockResolvedValue([{ id: id(1), tags: [] }]);
    mockTag.update.mockResolvedValue({ id: id(1), name: 'n' });

    const { req, res } = fireWith('POST', { action: 'addTags', sessionIds: [id(1), id(2), 'bad'], tags: ['t'] });
    await handler(req, res);

    expect(mockTag.update).toHaveBeenCalledTimes(1);
    const { results, okCount } = res._getJSONData();
    expect(okCount).toBe(1);
    expect(results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
      [id(1), true],
      [id(2), false],
      ['bad', false],
    ]);
  });

  it.each([
    ['a whitespace-only tag', { action: 'addTags', sessionIds: [id(1)], tags: ['  '] }],
    ['no tags', { action: 'addTags', sessionIds: [id(1)], tags: [] }],
    ['no sessions', { action: 'addTags', sessionIds: [], tags: ['t'] }],
    ['a non-array', { action: 'generateTags', sessionIds: id(1) }],
    ['more ids than the cap', { action: 'generateTags', sessionIds: Array.from({ length: 101 }, (_, i) => `x${i}`) }],
  ])('rejects %s with 400', async (_, body) => {
    const { req, res } = fireWith('POST', body);
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockTag.update).not.toHaveBeenCalled();
    expect(mockTag.publish).not.toHaveBeenCalled();
  });

  it.each(['addTags', 'generateTags'])('refuses %s for an API key without notebooks:write', async action => {
    withScopes([]);
    const { req, res } = fireWith('POST', { action, sessionIds: [id(1)], tags: ['t'] });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(mockTag.findUpdatable).not.toHaveBeenCalled();
    expect(mockTag.findTaggable).not.toHaveBeenCalled();
  });

  it('keeps the bulk delete open to a key without notebooks:write', async () => {
    withScopes([]);
    const { req, res } = fire([id(1)]);
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
  });

  it('checks credits once for every accessible session before queueing any', async () => {
    mockTag.findTaggable.mockResolvedValue([{ id: id(1) }, { id: id(2) }, { id: id(3) }]);

    const { req, res } = fireWith('POST', { action: 'generateTags', sessionIds: [id(1), id(2), id(3), id(4)] });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockTag.credits).toHaveBeenCalledTimes(1);
    expect(mockTag.credits).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', operationCount: 3 }));
    expect(mockTag.publish).toHaveBeenCalledTimes(3);
    expect(mockTag.credits.mock.invocationCallOrder[0]).toBeLessThan(mockTag.publish.mock.invocationCallOrder[0]);
    expect(mockTag.publish).toHaveBeenCalledWith({ sessionId: id(1), requesterId: 'user-1', payerId: 'user-1' });
    const { results, okCount } = res._getJSONData();
    expect(okCount).toBe(3);
    expect(results[3]).toEqual({ id: id(4), ok: false, error: 'Cannot update session' });
  });

  it('reports jobs already queued when a later publish fails', async () => {
    mockTag.findTaggable.mockResolvedValue([{ id: id(1) }, { id: id(2) }]);
    mockTag.publish.mockResolvedValueOnce('job-1').mockRejectedValueOnce(new Error('queue down'));

    const { req, res } = fireWith('POST', { action: 'generateTags', sessionIds: [id(1), id(2)] });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const { results, okCount } = res._getJSONData();
    expect(okCount).toBe(1);
    expect(results).toEqual([
      { id: id(1), ok: true },
      { id: id(2), ok: false, error: 'Could not queue tagging' },
    ]);
  });

  it('refuses generateTags in a write-enabled impersonation before anything is billed', async () => {
    mockFindById.mockResolvedValue({
      id: 'user-1',
      _id: 'user-1',
      isBanned: false,
      disputePending: false,
      aupAcceptedVersion: 'grandfathered',
      impersonatedBy: 'admin-1',
      // Write-enabled, so the gate admits the POST and the route's own refusal is what answers.
      impersonationWriteEnabled: true,
    });
    mockTag.findTaggable.mockResolvedValue([{ id: id(1) }]);

    const { req, res } = fireWith('POST', { action: 'generateTags', sessionIds: [id(1)] });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(mockTag.credits).not.toHaveBeenCalled();
    expect(mockTag.publish).not.toHaveBeenCalled();
  });

  it('queues nothing when the credit pre-flight refuses', async () => {
    mockTag.findTaggable.mockResolvedValue([{ id: id(1) }, { id: id(2) }]);
    mockTag.credits.mockRejectedValue(Object.assign(new Error('Insufficient credits'), { status: 402 }));

    const { req, res } = fireWith('POST', { action: 'generateTags', sessionIds: [id(1), id(2)] });
    await handler(req, res);

    expect(res._getStatusCode()).not.toBe(200);
    expect(mockTag.publish).not.toHaveBeenCalled();
  });
});
