// @vitest-environment node
/**
 * Integration test for POST /api/overwatch/v1/events.
 *
 * Unlike events.test.ts - which mocks `baseApi` down to a passthrough and
 * hand-injects req.body / req.apiKeyInfo - this test imports the REAL handler,
 * i.e. the full next-connect middleware chain that `baseApi` assembles:
 *
 *   logging -> body-size guard -> connectDB -> passport -> apiKeyAuth ->
 *   anomaly detection -> rate-limit -> JWT auth -> handler, with errorHandler
 *   mapping thrown errors to status codes.
 *
 * Only the data/AWS edges are stubbed (DB connect, API-key validation, the user
 * lookup, the Mongo-backed rate-limit counter, SQS send, CloudWatch emit). The
 * middleware ordering, scope enforcement, body-size limit, and error->status
 * mapping all run for real - which is exactly what the passthrough-mocked unit
 * test cannot exercise. The `bodyParser: false` regression is the
 * *class* of middleware/config-level bug this style of test exists to catch.
 *
 * Known coverage boundary: this drives the next-connect chain directly via
 * node-mocks-http, so Next.js's *own* framework-level body parser (toggled by
 * the route's `config.api.bodyParser` export) still runs above this layer and
 * is not exercised here - catching that specific layer end-to-end would require
 * booting a real Next server (e.g. next-test-api-route-handler), a dev
 * dependency this test deliberately avoids. As a cheap proxy for the exact
 * that regression, the route's exported `config` is asserted statically below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

// All mock fns are declared together via vi.hoisted so they exist before the
// (hoisted) vi.mock factories below capture them - one consistent style.
const { mockSendBatch, mockEmitMetric, mockEmitMetrics, mockValidate, mockFindById, mockRateLimit } = vi.hoisted(
  () => ({
    mockSendBatch: vi.fn(),
    mockEmitMetric: vi.fn().mockResolvedValue(undefined),
    mockEmitMetrics: vi.fn().mockResolvedValue(undefined),
    mockValidate: vi.fn(),
    mockFindById: vi.fn(),
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

// --- AWS edges (mocked) ---
vi.mock('@server/utils/sqs', () => ({ sendBatchToQueue: (...a: unknown[]) => mockSendBatch(...a) }));
vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: (...a: unknown[]) => mockEmitMetric(...a),
  emitMetrics: (...a: unknown[]) => mockEmitMetrics(...a),
}));
vi.mock('@server/utils/dlqRegistry', () => ({
  getSourceQueueUrl: () => 'https://sqs.us-east-2.amazonaws.com/123/overwatch',
}));

// Keep fire-and-forget analytics writes from touching the DB / polluting output.
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

// The real apiKeyRateLimit middleware runs; only its Mongo-backed counter check
// is stubbed (otherwise the query buffers forever against the stubbed connectDB).
// Overridable per-test (see the 429 case) via mockRateLimit.
vi.mock('@server/utils/apiKeyRateLimitCheck', () => ({
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

// The ONLY data dependency of the real apiKeyAuth middleware we control: key
// validation. Header parsing, scope check, error->status mapping, and
// req.apiKeyInfo population all run for real.
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

// connectDB must not hit a real Mongo; User.findById is stubbed so apiKeyAuth's
// user lookup resolves without a live DB. Everything else from the package is real.
vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
  };
});

import handler, { config } from '../events';
import { ApiKeyScope } from '@bike4mind/common';
import { Config } from '@server/utils/config';

const VALID_KEY = 'sk-test-valid-key';

function nowIso() {
  return new Date().toISOString();
}
function hoursAgoIso(h: number) {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: '550e8400-e29b-41d4-a716-446655440000',
    schemaVersion: 1,
    productId: 'vibeswire',
    userId: 'u1',
    sessionId: 's1',
    event: 'page_view',
    timestamp: nowIso(),
    ...overrides,
  };
}

function fire({
  body = { event: baseEvent() },
  apiKey = VALID_KEY,
  contentLength,
}: { body?: unknown; apiKey?: string | null; contentLength?: number } = {}) {
  const payload = JSON.stringify(body);
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/overwatch/v1/events',
      headers: {
        'content-type': 'application/json',
        'content-length': String(contentLength ?? Buffer.byteLength(payload)),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: body as Record<string, unknown>,
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http's mock req/res are not structurally assignable to the
  // Express Request/Response the next-connect handler is typed against; the
  // existing unit test casts the same way.
  return { req: req as any, res: res as any };
}

describe('POST /api/overwatch/v1/events (integration — real middleware chain)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Config as Record<string, string>).OVERWATCH_INGEST_ENABLED = 'true';
    mockSendBatch.mockResolvedValue([{ index: 0, success: true, messageId: 'msg-1' }]);

    mockValidate.mockImplementation(async (key: string) => {
      if (key === VALID_KEY) {
        return {
          isValid: true,
          keyId: 'k1',
          userId: 'user-1',
          scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE],
          rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
          productId: 'vibeswire',
        };
      }
      return { isValid: false, reason: 'not found' };
    });

    // mongoose findById returns a thenable Query; apiKeyAuth awaits it. A real
    // Promise (not a minimal then-shim) so any future .catch() path is honored.
    // aupAcceptedVersion is set because a real API-key holder is always a pre-existing account
    // (grandfathered by the P0-B backfill) or a consented one - a brand-new account cannot mint
    // a key before consenting. Without it the consent gate (auth.ts) would 403 this request.
    mockFindById.mockReturnValue(
      Promise.resolve({
        id: 'user-1',
        _id: 'user-1',
        isBanned: false,
        disputePending: false,
        aupAcceptedVersion: 'grandfathered',
      })
    );

    // Default: under the limit. The 429 case overrides this.
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
  });

  afterEach(() => {
    (Config as Record<string, string>).OVERWATCH_INGEST_ENABLED = 'true';
  });

  describe('route config (guards the exact class of regression)', () => {
    it('does not disable Next.js body parsing via the exported config', () => {
      // A `config.api.bodyParser: false` regression here previously slipped through. The next-connect
      // chain below cannot see that framework-level toggle, so pin it statically:
      // the route must never ship `bodyParser: false`.
      const api = (config as { api?: { bodyParser?: unknown; externalResolver?: unknown } }).api;
      expect(api?.bodyParser).not.toBe(false);
      expect(api?.externalResolver).toBe(true);
    });
  });

  describe('happy path through the full chain', () => {
    it('accepts a valid single event (200) and queues it', async () => {
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toMatchObject({ accepted: 1, rejected: 0 });
      expect(mockSendBatch).toHaveBeenCalledTimes(1);
      // Through the REAL middleware chain, both the per-product IngestRequest and the
      // dimensionless IngestRequestTotal (which powers the global silent-ingest alarm)
      // must reach emitMetrics - guards against a future middleware change short-circuiting
      // before the emit. The unit test asserts the same in isolation; this proves it survives
      // the full auth/rate-limit chain.
      expect(mockEmitMetrics).toHaveBeenCalledWith('Lumina5/OverwatchIngest', [
        expect.objectContaining({ name: 'IngestRequest', dimensions: { productId: 'vibeswire' } }),
        expect.objectContaining({ name: 'IngestRequestTotal' }),
      ]);
    });

    it('accepts a valid batch (200) and queues every event', async () => {
      const events = Array.from({ length: 25 }, (_, i) =>
        baseEvent({ eventId: `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}` })
      );
      mockSendBatch.mockResolvedValue(events.map((_, i) => ({ index: i, success: true, messageId: `m-${i}` })));
      const { req, res } = fire({ body: { events } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect((mockSendBatch.mock.calls[0][1] as unknown[]).length).toBe(25);
    });

    it('sets real X-RateLimit-* headers (proves apiKeyRateLimit middleware ran)', async () => {
      const { req, res } = fire();
      await handler(req, res);
      expect(res.getHeader('X-RateLimit-Limit-Minute')).toBe('60');
      expect(res.getHeader('X-RateLimit-Remaining-Day')).toBe('999');
    });
  });

  describe('authentication enforced by the real chain', () => {
    it('rejects a request with NO api key (401) at the JWT auth middleware', async () => {
      const { req, res } = fire({ apiKey: null });
      await handler(req, res);
      // NOTE: with auth:true the JWT `auth` middleware rejects unauthenticated
      // requests *before* the handler's own `!req.apiKeyInfo` 401 is reached, so
      // production returns this shape - NOT the handler's `{error:'API key required'}`.
      // The passthrough-mocked unit test asserts the latter; only this integration
      // test sees what callers actually get.
      expect(res._getStatusCode()).toBe(401);
      expect(res._getJSONData()).toMatchObject({ error: 'Unauthorized' });
      expect(mockSendBatch).not.toHaveBeenCalled();
    });

    it('rejects an invalid api key (401) — apiKeyAuth throws, errorHandler maps it', async () => {
      const { req, res } = fire({ apiKey: 'sk-bogus' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(401);
      expect(mockSendBatch).not.toHaveBeenCalled();
    });

    it('rejects a valid key lacking the ingest scope (403) at the handler', async () => {
      mockValidate.mockResolvedValue({
        isValid: true,
        keyId: 'k2',
        userId: 'user-1',
        scopes: ['read:data'],
        rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
        productId: 'vibeswire',
      });
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().error).toMatch(/scope/i);
      expect(mockSendBatch).not.toHaveBeenCalled();
    });

    it('rejects a banned user (401) — apiKeyAuth refuses before the handler', async () => {
      mockFindById.mockReturnValue(
        Promise.resolve({ id: 'user-1', _id: 'user-1', isBanned: true, disputePending: false })
      );
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(401);
      expect(res._getJSONData().error).toMatch(/banned/i);
      // apiKeyAuth short-circuits before the rate-limit middleware
      expect(mockRateLimit).not.toHaveBeenCalled();
      expect(mockSendBatch).not.toHaveBeenCalled();
    });

    it('rejects a dispute-pending user (403) — apiKeyAuth ForbiddenError', async () => {
      mockFindById.mockReturnValue(
        Promise.resolve({ id: 'user-1', _id: 'user-1', isBanned: false, disputePending: true })
      );
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
      // distinguish from the scope-check 403 above (message is the dispute one)
      expect(res._getJSONData().error).toMatch(/dispute/i);
      expect(mockRateLimit).not.toHaveBeenCalled();
      expect(mockSendBatch).not.toHaveBeenCalled();
    });
  });

  describe('request guards in the real chain', () => {
    it('returns 413 when Content-Length exceeds the route maxBodySize (real body-size guard)', async () => {
      // The body-size middleware reads Content-Length before the handler; the unit
      // test cannot reach it because it mocks baseApi away entirely.
      const { req, res } = fire({ contentLength: 256 * 1024 + 1 });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(413);
      expect(mockSendBatch).not.toHaveBeenCalled();
    });

    it('returns 503 when the kill switch is active', async () => {
      (Config as Record<string, string>).OVERWATCH_INGEST_ENABLED = 'false';
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(503);
      expect(mockSendBatch).not.toHaveBeenCalled();
    });

    it('returns 429 with Retry-After when the rate limit is exceeded (real apiKeyRateLimit)', async () => {
      mockRateLimit.mockResolvedValue({
        allowed: false,
        retryAfter: 30,
        error: 'Rate limit exceeded',
        headers: RATE_LIMIT_HEADERS,
      });
      const { req, res } = fire();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(429);
      expect(res.getHeader('Retry-After')).toBe(30);
      // ingest keys emit a per-product RateLimitHit metric on the way out
      expect(mockEmitMetric).toHaveBeenCalledWith(
        'Lumina5/OverwatchIngest',
        'RateLimitHit',
        1,
        { productId: 'vibeswire' },
        expect.anything()
      );
      expect(mockSendBatch).not.toHaveBeenCalled();
    });
  });

  describe('payload validation (400, not 500)', () => {
    it('returns 400 for a malformed envelope', async () => {
      const { req, res } = fire({ body: { not: 'an envelope' } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(mockSendBatch).not.toHaveBeenCalled();
    });

    it('returns 400 (not 500) when every event in a batch is rejected', async () => {
      const { req, res } = fire({ body: { event: baseEvent({ timestamp: hoursAgoIso(48) }) } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData()).toMatchObject({ accepted: 0 });
      expect(mockSendBatch).not.toHaveBeenCalled();
    });
  });
});
