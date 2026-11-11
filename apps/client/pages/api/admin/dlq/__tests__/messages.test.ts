// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handler: undefined as undefined | Handler,
  receiveFromQueue: vi.fn(),
  resolveConsumerLogsForSourceQueue: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => ({
    get: (fn: Handler) => {
      h.handler = fn;
      return fn;
    },
  }),
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqByLabel: (label: string) => (label === 'q1' ? { label, sourceQueue: 'webhookDeliveryQueue' } : undefined),
  getDlqUrl: () => 'https://sqs.example/dlq',
}));
vi.mock('@bike4mind/server-utils/utils/dlqConsumerLogs', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/dlqConsumerLogs')>()),
  resolveConsumerLogsForSourceQueue: h.resolveConsumerLogsForSourceQueue,
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ receiveFromQueue: h.receiveFromQueue }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn() } }));

import '../messages';

const message = { MessageId: 'm1', Body: '{}', ReceiptHandle: 'handle-1', Attributes: {} };

const consumerLogs = {
  region: 'us-east-2',
  logGroups: ['/aws/lambda/app-stage-WebhookConsumer'],
  retryWindowMs: 30 * 60_000,
};

const peek = async (adminPermissions: string[], queue = 'q1') => {
  const res = { json: vi.fn() };
  await h.handler!({ query: { queue }, user: { id: 'u1', isAdmin: false, adminPermissions } }, res);
  return res.json.mock.calls[0][0] as {
    messages: Array<{
      messageId?: string;
      body?: string;
      receiptHandle?: string;
      approximateReceiveCount?: string;
      logsUrl?: string | null;
    }>;
  };
};

// The console hash double-encodes: '$' stands for '%' in the outer layer, '*' in the inner one.
const decodeConsoleUrl = (url: string) =>
  decodeURIComponent(decodeURIComponent(url.split('#')[1].replace(/\$/g, '%')).replace(/\*/g, '%'));

describe('GET /api/admin/dlq/messages', () => {
  beforeEach(() => {
    h.receiveFromQueue.mockReset().mockResolvedValue([message]);
    h.resolveConsumerLogsForSourceQueue.mockReset().mockResolvedValue(consumerLogs);
  });

  it('holds messages and returns receipt handles for a settings:manage caller', async () => {
    const body = await peek(['settings:manage']);

    expect(h.receiveFromQueue).toHaveBeenCalledWith('https://sqs.example/dlq', 10, 120);
    expect(body.messages[0].receiptHandle).toBe('handle-1');
  });

  it('leaves messages visible and omits receipt handles for a support:read caller', async () => {
    const body = await peek(['support:read']);

    expect(h.receiveFromQueue).toHaveBeenCalledWith('https://sqs.example/dlq', 10, 0);
    expect(body.messages[0].receiptHandle).toBeUndefined();
  });

  it('returns one row per message id, keeping the copy with the highest receive count', async () => {
    h.receiveFromQueue.mockResolvedValue([
      { MessageId: 'dup', Body: 'older', ReceiptHandle: 'h-old', Attributes: { ApproximateReceiveCount: '2' } },
      { MessageId: 'other', Body: 'x', ReceiptHandle: 'h-other', Attributes: { ApproximateReceiveCount: '1' } },
      { MessageId: 'dup', Body: 'newer', ReceiptHandle: 'h-new', Attributes: { ApproximateReceiveCount: '3' } },
    ]);

    const body = await peek(['support:read']);

    expect(body.messages).toHaveLength(2);
    expect(body.messages.find(m => m.messageId === 'dup')).toMatchObject({
      body: 'newer',
      approximateReceiveCount: '3',
    });
  });

  it('links each row to its consumer logs in a window around the send time', async () => {
    const sent = Date.UTC(2026, 0, 2, 3, 0, 0);
    h.receiveFromQueue.mockResolvedValue([
      { MessageId: 'm1', Body: '{}', Attributes: { SentTimestamp: String(sent) } },
    ]);

    const body = await peek(['support:read']);

    expect(h.resolveConsumerLogsForSourceQueue).toHaveBeenCalledWith('webhookDeliveryQueue');
    const url = body.messages[0].logsUrl!;
    expect(url.startsWith('https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#')).toBe(true);
    const detail = decodeConsoleUrl(url);
    expect(detail).toContain(`start~'${new Date(sent - 2 * 60_000).toISOString()}`);
    expect(detail).toContain(`end~'${new Date(sent + 30 * 60_000 + 5 * 60_000).toISOString()}`);
    expect(detail).toContain("'/aws/lambda/app-stage-WebhookConsumer");
    expect(url).not.toMatch(/\d{12}/);
  });

  it('returns a null logsUrl when the row has no send time', async () => {
    const body = await peek(['support:read']);

    expect(body.messages[0].logsUrl).toBeNull();
  });

  it('returns null logsUrls when the consumer cannot be resolved', async () => {
    h.resolveConsumerLogsForSourceQueue.mockResolvedValue(null);
    h.receiveFromQueue.mockResolvedValue([
      { MessageId: 'm1', Attributes: { SentTimestamp: String(1_767_322_800_000) } },
    ]);

    const body = await peek(['support:read']);

    expect(body.messages[0].logsUrl).toBeNull();
  });

  it('rejects an unknown queue before any AWS call', async () => {
    await expect(peek(['support:read'], 'nope')).rejects.toThrow('Unknown DLQ: nope');

    expect(h.receiveFromQueue).not.toHaveBeenCalled();
    expect(h.resolveConsumerLogsForSourceQueue).not.toHaveBeenCalled();
  });
});
