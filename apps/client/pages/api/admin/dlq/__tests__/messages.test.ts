// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  receiveFromQueue: vi.fn(),
}));

type Route = (req: unknown, res: unknown) => unknown;

vi.mock('@bike4mind/common', () => ({ ApiKeyScope: { ADMIN: 'admin' } }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => {
    const routes: Record<string, Route> = {};
    const chain: Record<string, unknown> & Route = Object.assign(
      async (req: unknown, res: unknown) => {
        return routes[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (_middleware: unknown) => chain,
        get: (fn: Route) => ((routes.GET = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqByLabel: () => ({ label: 'quest', displayName: 'Quest queue', sourceQueue: 'questQueue' }),
  getDlqUrl: () => 'dlq-url',
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  receiveFromQueue: h.receiveFromQueue,
}));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  BadRequestError: class BadRequestError extends Error {},
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import handler from '../messages';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/admin/dlq/messages', () => {
  const makeMsg = (id: string, count: string) => ({
    MessageId: id,
    Body: '{"foo":"bar"}',
    ReceiptHandle: `rh-${id}`,
    Attributes: { SentTimestamp: '1700000000000', ApproximateReceiveCount: count },
  });

  it('uses immediate visibility when browsing messages', async () => {
    h.receiveFromQueue.mockResolvedValue([makeMsg('m1', '3')]);
    const { req, res } = createMocks({ method: 'GET', query: { queue: 'quest', maxMessages: '5' } });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await (handler as unknown as Route)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(h.receiveFromQueue).toHaveBeenCalledWith('dlq-url', 5, 0);
  });

  it('viewing the same page twice does not change the visibility timeout argument', async () => {
    h.receiveFromQueue.mockResolvedValue([makeMsg('m1', '3')]);

    for (let i = 0; i < 2; i++) {
      const { req, res } = createMocks({ method: 'GET', query: { queue: 'quest' } });
      (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
      await (handler as unknown as Route)(req, res);
      expect(res._getStatusCode()).toBe(200);
    }

    expect(h.receiveFromQueue).toHaveBeenCalledTimes(2);
    for (const call of h.receiveFromQueue.mock.calls) {
      expect(call[2]).toBe(0);
    }
  });

  it('returns messages with their approximate receive count unchanged', async () => {
    h.receiveFromQueue.mockResolvedValue([makeMsg('m1', '14')]);
    const { req, res } = createMocks({ method: 'GET', query: { queue: 'quest' } });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await (handler as unknown as Route)(req, res);

    const body = res._getJSONData();
    expect(body.messages[0].approximateReceiveCount).toBe('14');
    expect(body.messages[0]).not.toHaveProperty('receiptHandle');
  });
});
