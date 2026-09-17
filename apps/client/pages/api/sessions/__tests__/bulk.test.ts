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

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit-Minute': '60',
  'X-RateLimit-Remaining-Minute': '59',
  'X-RateLimit-Reset-Minute': '0',
  'X-RateLimit-Limit-Day': '1000',
  'X-RateLimit-Remaining-Day': '999',
  'X-RateLimit-Reset-Day': '0',
};

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

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
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
  };
});

import handler from '../bulk';
import { SessionEvents } from '@bike4mind/common';

// Authenticates by API key for the same reason the /api/sessions/[id] suite does: apiKeyAuth sets
// req.user and the real auth middleware then skips passport, so no auth stub is needed.
function fire(sessionIds: string[]) {
  const payload = JSON.stringify({ sessionIds });
  const { req, res } = createMocks(
    {
      method: 'DELETE',
      url: '/api/sessions/bulk',
      headers: {
        'x-api-key': 'sk-test-valid-key',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      },
      body: { sessionIds },
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

describe('DELETE /api/sessions/bulk', () => {
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
  });

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
