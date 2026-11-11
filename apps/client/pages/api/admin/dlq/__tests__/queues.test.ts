// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handler: undefined as undefined | Handler,
  getQueueAttributes: vi.fn(),
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
  getDlqRegistry: () => [
    { label: 'short-dlq', displayName: 'Short', application: 'app' },
    { label: 'long-dlq', displayName: 'Long', application: 'app' },
    { label: 'broken-dlq', displayName: 'Broken', application: 'app' },
    { label: 'events', displayName: 'Events', application: 'Example', sourceQueue: null, replay: 'unsafe' },
  ],
  getDlqUrl: (label: string) => `https://sqs.example/${label}`,
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ getQueueAttributes: h.getQueueAttributes }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), warn: vi.fn() } }));

import '../queues';

type QueueRow = {
  label: string;
  displayName: string;
  application: string;
  replay?: string;
  approximateMessageCount: number;
  approximateNotVisibleCount: number;
  messageRetentionSeconds?: number;
};

const fetchQueues = async () => {
  const res = { json: vi.fn() };
  await h.handler!({ user: { id: 'u1' } }, res);
  return (res.json.mock.calls[0][0] as { queues: QueueRow[] }).queues;
};

describe('GET /api/admin/dlq/queues', () => {
  beforeEach(() => {
    h.getQueueAttributes.mockReset().mockImplementation(async (url: string) => {
      if (url.endsWith('broken-dlq')) throw new Error('SQS unreachable');
      return {
        approximateMessageCount: 2,
        approximateNotVisibleCount: 0,
        messageRetentionSeconds: url.endsWith('short-dlq') ? 345600 : 1209600,
      };
    });
  });

  it('returns each queue with its own message retention', async () => {
    const queues = await fetchQueues();

    expect(queues.find(q => q.label === 'short-dlq')?.messageRetentionSeconds).toBe(345600);
    expect(queues.find(q => q.label === 'long-dlq')?.messageRetentionSeconds).toBe(1209600);
  });

  it('returns a queue whose attributes failed to load without retention', async () => {
    const broken = (await fetchQueues()).find(q => q.label === 'broken-dlq');

    expect(broken?.approximateMessageCount).toBe(-1);
    expect(broken?.messageRetentionSeconds).toBeUndefined();
  });

  it.each([false, true])('lists unsafe queues and their safety even when attributes fail: %s', async fail => {
    if (fail) h.getQueueAttributes.mockRejectedValue(new Error('Unavailable'));
    const events = (await fetchQueues()).find(q => q.label === 'events');

    expect(events).toMatchObject({
      label: 'events',
      displayName: 'Events',
      application: 'Example',
      replay: 'unsafe',
      approximateMessageCount: fail ? -1 : 2,
      approximateNotVisibleCount: fail ? -1 : 0,
    });
    expect(events?.messageRetentionSeconds).toBe(fail ? undefined : 1209600);
    expect(h.getQueueAttributes).toHaveBeenCalledWith('https://sqs.example/events');
  });
});
