// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  receiveFromQueue: vi.fn(),
  sendToQueue: vi.fn(),
  deleteFromQueue: vi.fn(),
  countAttempts: vi.fn(),
  logReplay: vi.fn(),
}));

type Route = (req: unknown, res: unknown) => unknown;

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Route> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain: Record<string, unknown> & Route = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return routes[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (middleware: (req: unknown, res: unknown, next: () => void) => void) => (
          middlewares.push(middleware),
          chain
        ),
        post: (fn: Route) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqByLabel: () => ({ label: 'quest', displayName: 'Quest queue', sourceQueue: 'questQueue' }),
  getDlqUrl: () => 'dlq-url',
  getSourceQueueUrl: () => 'source-url',
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  receiveFromQueue: h.receiveFromQueue,
  sendToQueue: h.sendToQueue,
  deleteFromQueue: h.deleteFromQueue,
}));
vi.mock('@bike4mind/database', () => ({
  dlqReplayLogRepository: { countAttempts: h.countAttempts, logReplay: h.logReplay },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../replay';

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.sendToQueue.mockResolvedValue(undefined);
  h.deleteFromQueue.mockResolvedValue(undefined);
  h.countAttempts.mockResolvedValue(0);
  h.logReplay.mockResolvedValue(undefined);
});

describe('POST /api/admin/dlq/replay admin audit', () => {
  it('records ops.dlq.replayed with the queue and count but no message bodies', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      body: {
        queueLabel: 'quest',
        messages: [{ messageId: 'm1', receiptHandle: 'r1', body: '{"secret":"payload"}' }],
      },
    });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await (handler as unknown as Route)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.dlq.replayed',
      target: { kind: 'system', id: 'dlq-replay' },
      details: { queueLabel: 'quest', messageCount: 1, replayedMessageIds: ['m1'] },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('payload');
    expect(h.sendToQueue.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('records the queued replay path with counts and ids but no message bodies', async () => {
    h.receiveFromQueue.mockResolvedValue([
      { MessageId: 'm1', ReceiptHandle: 'r1', Body: '{"secret":"payload"}' },
      { MessageId: 'm2', ReceiptHandle: 'r2', Body: 'not json' },
    ]);
    const { req, res } = createMocks({ method: 'POST', body: { queueLabel: 'quest', batchSize: 2 } });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await (handler as unknown as Route)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.dlq.replayed',
      details: { queueLabel: 'quest', messageCount: 1, failed: 1, skipped: 0, total: 2, replayedMessageIds: ['m1'] },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('payload');
    expect(h.sendToQueue.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});
