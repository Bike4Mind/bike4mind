// @vitest-environment node
/**
 * Integration test for GET/PUT/DELETE /api/sessions/[id].
 *
 * Imports the REAL default-exported handler and drives it through its own method
 * dispatcher (apps/client/pages/api/sessions/[id]/index.ts): GET/DELETE run the
 * real next-connect chain baseApi() assembles, PUT runs the real chain
 * nextRouteForContract(sessionUpdateContract) assembles - including the
 * notebooks:write scope gate. This is what defineNextRoute.test.ts cannot cover
 * on its own (that file drives the adapter against a FIXTURE contract); this
 * proves the actual dispatcher branch, the real sessionUpdateContract, and the
 * sessionService wiring all fit together. Only data/AWS edges are stubbed
 * (connectDB, the User lookup, sessionService, storage).
 *
 * `@server/auth/auth` is intentionally left UNMOCKED: its real first middleware
 * already skips passport when apiKeyAuth has set req.user, and 401s a request with
 * no credential at all - exactly the two cases these tests need, with no stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const {
  mockValidate,
  mockFindById,
  mockRateLimit,
  mockGetSession,
  mockUpdateSession,
  mockDeleteSession,
  mockLogEvent,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGetSession: vi.fn(),
  mockUpdateSession: vi.fn(),
  mockDeleteSession: vi.fn(),
  mockLogEvent: vi.fn(),
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
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

// Avoids constructing a real S3Storage (which reads an SST-bound bucket resource
// unavailable in a test process) - only PUT's adapters touch this.
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn(), getMetadata: vi.fn() }),
}));

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
      getSession: (...a: unknown[]) => mockGetSession(...a),
      updateSession: (...a: unknown[]) => mockUpdateSession(...a),
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
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
  };
});

import handler from '../index';
import { ApiKeyScope, SessionEvents } from '@bike4mind/common';

const VALID_KEY = 'sk-test-valid-key';

function fire({
  method,
  apiKey = VALID_KEY as string | null,
  body,
}: {
  method: 'GET' | 'PUT' | 'DELETE';
  apiKey?: string | null;
  body?: unknown;
}) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const { req, res } = createMocks(
    {
      method,
      url: '/api/sessions/sess-1',
      query: { id: 'sess-1' },
      headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(payload
          ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
          : {}),
      },
      body,
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

function keyWithScopes(scopes: ApiKeyScope[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

describe('/api/sessions/[id] (integration - dispatcher + contract wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // aupAcceptedVersion is required by the shared consent-gate middleware (any
    // request without it 403s with "Policy acceptance required" before reaching
    // the handler) - a grandfathered sentinel, matching auth-behavior.integration.test.ts.
    mockFindById.mockResolvedValue({
      id: 'user-1',
      _id: 'user-1',
      isBanned: false,
      disputePending: false,
      aupAcceptedVersion: 'grandfathered',
    });
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
    mockLogEvent.mockResolvedValue(undefined);
    // GET/DELETE (baseApi()) declare no scope; a key with none of the AI/notebook
    // scopes must still be admitted to those two verbs.
    keyWithScopes([]);
  });

  describe('GET', () => {
    it('reads the session by the id in the path and redacts systemPromptText', async () => {
      mockGetSession.mockResolvedValue({
        id: 'sess-1',
        name: 'Untitled',
        userId: 'user-1',
        systemPromptText: 'top secret prompt',
      });
      const { req, res } = fire({ method: 'GET' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockGetSession).toHaveBeenCalledWith('user-1', { id: 'sess-1' }, expect.anything());
      expect(res._getJSONData()).not.toHaveProperty('systemPromptText');
    });
  });

  describe('PUT', () => {
    it('validates the body via sessionUpdateContract, updates with the path id, and redacts the response', async () => {
      keyWithScopes([ApiKeyScope.WRITE_NOTEBOOKS]);
      mockUpdateSession.mockResolvedValue({
        id: 'sess-1',
        name: 'Untitled',
        userId: 'user-1',
        knowledgeIds: ['fab-1'],
        forceKnowledgeRetrieval: true,
        firstCreated: new Date('2026-01-01T00:00:00Z'),
        lastUpdated: new Date('2026-01-02T00:00:00Z'),
        systemPromptText: 'top secret prompt',
      });
      const { req, res } = fire({
        method: 'PUT',
        body: { knowledgeIds: ['fab-1'], forceKnowledgeRetrieval: true },
      });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockUpdateSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.objectContaining({ id: 'sess-1', knowledgeIds: ['fab-1'], forceKnowledgeRetrieval: true }),
        expect.anything()
      );
      expect(res._getJSONData()).not.toHaveProperty('systemPromptText');
      // apiKeyAuth also fires its own usage-logging logEvent call through this same
      // mocked module, so assert the handler's own event was among them rather than
      // asserting an exact total.
      expect(mockLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SessionEvents.UPDATE_SESSION,
          metadata: expect.objectContaining({ sessionId: 'sess-1' }),
        }),
        expect.anything()
      );
    });

    it('403s a key without notebooks:write before the handler runs', async () => {
      keyWithScopes([ApiKeyScope.READ_FILES]);
      const { req, res } = fire({ method: 'PUT', body: { name: 'x' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
      expect(mockUpdateSession).not.toHaveBeenCalled();
    });

    it('422s a malformed body without calling updateSession (contract validation ran)', async () => {
      keyWithScopes([ApiKeyScope.WRITE_NOTEBOOKS]);
      const { req, res } = fire({ method: 'PUT', body: { forceKnowledgeRetrieval: 'not-a-boolean' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(mockUpdateSession).not.toHaveBeenCalled();
    });

    // Proves auth is actually wired into THIS route, not just into the adapter in
    // isolation (defineNextRoute.test.ts covers the adapter with a fixture contract).
    it('401s an unauthenticated PUT before the handler runs', async () => {
      const { req, res } = fire({ method: 'PUT', apiKey: null, body: { name: 'x' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(401);
      expect(mockUpdateSession).not.toHaveBeenCalled();
    });

    // id is addressed via the URL path (validatedParams), never the body - a body
    // id must be silently ignored, not smuggled through as the update target.
    it('ignores an id sent in the body, using only the path id', async () => {
      keyWithScopes([ApiKeyScope.WRITE_NOTEBOOKS]);
      mockUpdateSession.mockResolvedValue({
        id: 'sess-1',
        name: 'renamed',
        userId: 'user-1',
        firstCreated: new Date('2026-01-01T00:00:00Z'),
        lastUpdated: new Date('2026-01-02T00:00:00Z'),
      });
      const { req, res } = fire({ method: 'PUT', body: { id: 'sneaky-other-id', name: 'renamed' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockUpdateSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'sess-1' }),
        expect.anything()
      );
    });
  });

  describe('DELETE', () => {
    it('deletes the session by the path id and returns the new last-notebook id', async () => {
      mockDeleteSession.mockResolvedValue({ id: 'other-session' });
      const { req, res } = fire({ method: 'DELETE' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockDeleteSession).toHaveBeenCalledWith('user-1', { id: 'sess-1' }, expect.anything());
      expect(res._getJSONData()).toEqual({ newLastNotebookId: 'other-session' });
      expect(mockLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: SessionEvents.DELETE_SESSION, metadata: { sessionId: 'sess-1' } }),
        expect.anything()
      );
    });

    it('returns a null newLastNotebookId when no session remains', async () => {
      mockDeleteSession.mockResolvedValue(undefined);
      const { req, res } = fire({ method: 'DELETE' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ newLastNotebookId: null });
    });
  });
});
