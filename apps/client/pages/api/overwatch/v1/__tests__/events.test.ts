// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (opts: unknown) => ({ post: (fn: (req: unknown, res: unknown) => unknown) => fn }),
}));

const mockSendBatch = vi.fn();
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  sendBatchToQueue: (...args: unknown[]) => mockSendBatch(...args),
}));

const mockEmitMetric = vi.fn().mockResolvedValue(undefined);
const mockEmitMetrics = vi.fn().mockResolvedValue(undefined);
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  emitMetric: (...args: unknown[]) => mockEmitMetric(...args),
  emitMetrics: (...args: unknown[]) => mockEmitMetrics(...args),
}));

const mockGetSourceQueueUrl = vi.fn().mockReturnValue('https://sqs.us-east-2.amazonaws.com/123/overwatch');
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getSourceQueueUrl: (...args: unknown[]) => mockGetSourceQueueUrl(...args),
}));

vi.mock('@bike4mind/common', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@bike4mind/common');
  return { ...actual };
});

vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { OVERWATCH_INGEST_ENABLED: 'true' },
}));

import handler from '../events';
import { ApiKeyScope } from '@bike4mind/common';
import { Config } from '@bike4mind/server-utils/utils/config';

function nowIso() {
  return new Date().toISOString();
}
function hoursAgoIso(h: number) {
  return new Date(Date.now() - h * 3600_000).toISOString();
}
function minutesAheadIso(m: number) {
  return new Date(Date.now() + m * 60_000).toISOString();
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

function createReq({
  body = { event: baseEvent() },
  apiKeyInfo = {
    scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE],
    productId: 'vibeswire',
    keyId: 'k1',
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  },
  ingestEnabled = 'true',
}: {
  body?: unknown;
  apiKeyInfo?: unknown;
  ingestEnabled?: string;
} = {}) {
  const { req, res } = createMocks({ method: 'POST', body: body as Record<string, unknown> });
  (req as any).apiKeyInfo = apiKeyInfo;
  (req as any).logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  (Config as Record<string, string>).OVERWATCH_INGEST_ENABLED = ingestEnabled;
  return { req: req as any, res: res as any };
}

describe('POST /api/overwatch/v1/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendBatch.mockResolvedValue([{ index: 0, success: true, messageId: 'msg-1' }]);
    mockEmitMetrics.mockResolvedValue(undefined);
    (Config as Record<string, string>).OVERWATCH_INGEST_ENABLED = 'true';
  });

  describe('authentication', () => {
    it('returns 401 when no apiKeyInfo (session-auth or no auth)', async () => {
      const { req, res } = createReq({ apiKeyInfo: null });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(401);
    });

    it('returns 403 when key lacks OVERWATCH_INGEST_WRITE scope', async () => {
      const { req, res } = createReq({
        apiKeyInfo: { scopes: ['read:data'], productId: 'vibeswire', keyId: 'k1', rateLimit: {} },
      });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().error).toMatch(/scope/i);
    });

    it('returns 403 when key has scope but no productId (unbound key)', async () => {
      const { req, res } = createReq({
        apiKeyInfo: { scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE], productId: undefined, keyId: 'k1', rateLimit: {} },
      });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().error).toMatch(/product/i);
    });
  });

  describe('kill switch', () => {
    it('returns 503 when OVERWATCH_INGEST_ENABLED is false', async () => {
      const { req, res } = createReq({ ingestEnabled: 'false' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(503);
    });

    it('does NOT emit IngestRequest or IngestRequestTotal when kill switch is active', async () => {
      const { req, res } = createReq({ ingestEnabled: 'false' });
      await handler(req, res);
      // Allow microtask queue to flush
      await Promise.resolve();
      expect(mockEmitMetrics).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('returns 200 and accepted:1 for a valid single event', async () => {
      const { req, res } = createReq();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toMatchObject({ accepted: 1, rejected: 0 });
    });

    it('calls sendBatchToQueue with the event', async () => {
      const { req, res } = createReq();
      await handler(req, res);
      expect(mockSendBatch).toHaveBeenCalledWith(expect.any(String), [
        expect.objectContaining({ productId: 'vibeswire' }),
      ]);
    });

    it('emits IngestRequest (per-product) and IngestRequestTotal (dimensionless) in one call', async () => {
      const { req, res } = createReq();
      await handler(req, res);
      await Promise.resolve();
      expect(mockEmitMetrics).toHaveBeenCalledWith('Lumina5/OverwatchIngest', [
        expect.objectContaining({ name: 'IngestRequest', dimensions: { productId: 'vibeswire' } }),
        expect.objectContaining({ name: 'IngestRequestTotal' }),
      ]);
      // IngestRequestTotal must have no dimensions (dimensionless = not even an empty object with productId)
      const [, metrics] = mockEmitMetrics.mock.calls[0] as [string, Array<{ name: string; dimensions?: unknown }>];
      const total = metrics.find(m => m.name === 'IngestRequestTotal')!;
      expect(total.dimensions).toBeUndefined();
    });

    it('batch of 50 events — calls sendBatchToQueue with all 50', async () => {
      mockSendBatch.mockResolvedValue(
        Array.from({ length: 50 }, (_, i) => ({ index: i, success: true, messageId: `m-${i}` }))
      );
      const events = Array.from({ length: 50 }, (_, i) =>
        baseEvent({
          eventId: `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`,
        })
      );
      const { req, res } = createReq({ body: { events } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockSendBatch).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([expect.any(Object)]));
      const batchArg = mockSendBatch.mock.calls[0][1] as unknown[];
      expect(batchArg).toHaveLength(50);
    });
  });

  describe('per-event validation', () => {
    it('rejects event with wrong productId (mismatch with key)', async () => {
      const { req, res } = createReq({ body: { event: baseEvent({ productId: 'other-product' }) } });
      await handler(req, res);
      const data = res._getJSONData();
      expect(data.results[0].status).toBe('rejected');
      expect(data.results[0].error).toMatch(/productId/);
    });

    it('rejects event with timestamp older than 24h', async () => {
      const { req, res } = createReq({ body: { event: baseEvent({ timestamp: hoursAgoIso(25) }) } });
      await handler(req, res);
      const data = res._getJSONData();
      expect(data.results[0].status).toBe('rejected');
      expect(data.results[0].error).toMatch(/timestamp/);
    });

    it('rejects event with timestamp more than 5 min in the future', async () => {
      const { req, res } = createReq({ body: { event: baseEvent({ timestamp: minutesAheadIso(10) }) } });
      await handler(req, res);
      const data = res._getJSONData();
      expect(data.results[0].status).toBe('rejected');
    });

    it('accepts event with schemaVersion equal to current', async () => {
      const { req, res } = createReq({ body: { event: baseEvent({ schemaVersion: 1 }) } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
    });

    it('rejects event with schemaVersion higher than current', async () => {
      const { req, res } = createReq({ body: { event: baseEvent({ schemaVersion: 99 }) } });
      await handler(req, res);
      const data = res._getJSONData();
      expect(data.results[0].status).toBe('rejected');
      expect(data.results[0].error).toMatch(/schemaVersion/);
    });
  });

  // The hop events are proof that a hop was minted or redeemed. Only this deployment's own paths
  // record them: the mint route queues hop_minted directly, and the redeem posts hop under the host
  // product's key. Any other key posting them would be forging a verified hop.
  describe('reserved hop events', () => {
    const hostKey = {
      scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE],
      productId: 'bike4mind',
      keyId: 'host-key',
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    };
    const hopMetadata = { hopId: 'a'.repeat(32), src: 'vibeswire', dest: 'bike4mind', verified: true };
    const eventId = (n: number) => `550e8400-e29b-41d4-a716-${String(n).padStart(12, '0')}`;

    it('refuses hop and hop_minted from a product key, one by one, and queues the rest of the batch', async () => {
      mockSendBatch.mockResolvedValue([{ index: 0, success: true, messageId: 'm-0' }]);
      const events = [
        baseEvent({ eventId: eventId(1), event: 'hop', metadata: hopMetadata }),
        baseEvent({ eventId: eventId(2), event: 'page_view' }),
        baseEvent({ eventId: eventId(3), event: 'hop_minted', metadata: { hopId: 'a'.repeat(32), dest: 'bike4mind' } }),
      ];
      const { req, res } = createReq({ body: { events } });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const data = res._getJSONData();
      expect(data).toMatchObject({ accepted: 1, rejected: 2 });
      expect(data.results[0]).toEqual({ index: 0, status: 'rejected', error: expect.stringMatching(/'hop'/) });
      expect(data.results[1]).toMatchObject({ index: 1, status: 'accepted' });
      expect(data.results[2]).toEqual({ index: 2, status: 'rejected', error: expect.stringMatching(/'hop_minted'/) });
      const queued = mockSendBatch.mock.calls[0][1] as Array<{ event: string }>;
      expect(queued.map(e => e.event)).toEqual(['page_view']);
    });

    it('answers 400 when every event in the request is a refused hop event', async () => {
      const { req, res } = createReq({ body: { event: baseEvent({ event: 'hop', metadata: hopMetadata }) } });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData()).toMatchObject({ accepted: 0, rejected: 1 });
      expect(mockSendBatch).not.toHaveBeenCalled();
    });

    it("accepts hop from the host app's own key: the redeem's path", async () => {
      const { req, res } = createReq({
        apiKeyInfo: hostKey,
        body: { event: baseEvent({ productId: 'bike4mind', event: 'hop', metadata: hopMetadata }) },
      });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().results[0].status).toBe('accepted');
    });

    it("refuses hop_minted even from the host app's key: the mint route never posts it here", async () => {
      const { req, res } = createReq({
        apiKeyInfo: hostKey,
        body: {
          event: baseEvent({ productId: 'bike4mind', event: 'hop_minted', metadata: { hopId: 'a'.repeat(32) } }),
        },
      });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().results[0]).toMatchObject({
        status: 'rejected',
        error: expect.stringMatching(/mint route/),
      });
    });
  });

  describe('envelope validation', () => {
    it('returns 400 for invalid envelope (not an object)', async () => {
      const { req, res } = createReq({ body: 'garbage' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
    });

    it('returns 400 when batch exceeds 100 events', async () => {
      const events = Array.from({ length: 101 }, (_, i) =>
        baseEvent({
          eventId: `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`,
        })
      );
      const { req, res } = createReq({ body: { events } });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
    });
  });

  describe('500 path', () => {
    it('returns 500 and emits IngestError (per-product) + IngestErrorTotal (dimensionless) when all events fail to queue', async () => {
      mockSendBatch.mockResolvedValue([{ index: 0, success: false, error: 'SQS down' }]);
      const { req, res } = createReq();
      await handler(req, res);
      expect(res._getStatusCode()).toBe(500);
      await Promise.resolve();
      expect(mockEmitMetrics).toHaveBeenCalledWith('Lumina5/OverwatchIngest', [
        expect.objectContaining({ name: 'IngestError', dimensions: { productId: 'vibeswire' } }),
        expect.objectContaining({ name: 'IngestErrorTotal' }),
      ]);
      // IngestErrorTotal must be dimensionless so the (dimensionless) overwatchIngestErrors alarm can fire
      const errorCall = (
        mockEmitMetrics.mock.calls as Array<[string, Array<{ name: string; dimensions?: unknown }>]>
      ).find(([, metrics]) => metrics.some(m => m.name === 'IngestErrorTotal'));
      expect(errorCall).toBeDefined();
      const total = errorCall![1].find(m => m.name === 'IngestErrorTotal');
      expect(total?.dimensions).toBeUndefined();
    });
  });

  // The Lambda can freeze once the response is sent, so a pending emit would be lost or sent later
  // with an expired SigV4 signature.
  describe('metric delivery', () => {
    const holdEmit = (mock: typeof mockEmitMetrics) => {
      let release: () => void = () => {};
      mock.mockReturnValueOnce(
        new Promise<void>(resolve => {
          release = resolve;
        })
      );
      return () => release();
    };

    it.each([
      ['the IngestRequest metric', mockEmitMetrics],
      ['the IngestLatency metric', mockEmitMetric],
    ])('does not respond while %s is still pending', async (_metric, mock) => {
      const releaseEmit = holdEmit(mock);
      const { req, res } = createReq();

      const handled = handler(req, res);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(res._isEndCalled()).toBe(false);

      releaseEmit();
      await handled;
      expect(res._getStatusCode()).toBe(200);
    });

    it('does not respond to a failed ingest while the IngestError metric is still pending', async () => {
      mockSendBatch.mockRejectedValue(new Error('SQS down'));
      mockEmitMetrics.mockResolvedValueOnce(undefined);
      const releaseEmit = holdEmit(mockEmitMetrics);
      const { req, res } = createReq();

      const handled = handler(req, res);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(res._isEndCalled()).toBe(false);

      releaseEmit();
      await handled;
      expect(res._getStatusCode()).toBe(500);
    });
  });
});
