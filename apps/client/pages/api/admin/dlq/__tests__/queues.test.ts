// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handler: undefined as undefined | Handler,
  adminPermissions: undefined as undefined | Record<string, string>,
  getQueueAttributes: vi.fn(),
  resolveConsumerLogsForSourceQueue: vi.fn(),
  getDlqUrl: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: { adminPermissions: Record<string, string> }) => {
    h.adminPermissions = options.adminPermissions;
    return {
      get: (fn: Handler) => {
        h.handler = fn;
        return fn;
      },
    };
  },
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqRegistry: () => [
    {
      label: 'webhook-delivery',
      displayName: 'Webhook Delivery',
      application: 'Webhooks',
      sourceQueue: 'webhookDeliveryQueue',
    },
    { label: 'image-edit', displayName: 'Image Edit', application: 'ImageGeneration', sourceQueue: 'imageEditQueue' },
  ],
  getDlqUrl: h.getDlqUrl,
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ getQueueAttributes: h.getQueueAttributes }));
vi.mock('@bike4mind/server-utils/utils/dlqConsumerLogs', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/dlqConsumerLogs')>()),
  resolveConsumerLogsForSourceQueue: h.resolveConsumerLogsForSourceQueue,
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), warn: vi.fn() } }));

import '../queues';

type QueueRow = {
  label: string;
  approximateMessageCount: number;
  logGroups: string[] | null;
  logsUrl: string | null;
};

const list = async () => {
  const res = { json: vi.fn() };
  await h.handler!({ user: { id: 'u1' } }, res);
  return res.json.mock.calls[0][0] as { queues: QueueRow[] };
};

const webhookLogs = {
  region: 'us-east-2',
  logGroups: ['/aws/lambda/app-stage-WebhookConsumer'],
  retryWindowMs: 3_600_000,
};

describe('GET /api/admin/dlq/queues', () => {
  beforeEach(() => {
    h.getQueueAttributes.mockReset().mockResolvedValue({ approximateMessageCount: 3, approximateNotVisibleCount: 0 });
    h.getDlqUrl.mockReset().mockImplementation((label: string) => `https://sqs.example/${label}-dlq`);
    h.resolveConsumerLogsForSourceQueue
      .mockReset()
      .mockImplementation(async (name: string) => (name === 'webhookDeliveryQueue' ? webhookLogs : null));
  });

  it('requires support:read', () => {
    expect(h.adminPermissions).toEqual({ GET: 'support:read' });
  });

  it('returns the consumer log groups and a Logs Insights link per queue', async () => {
    const { queues } = await list();

    const webhook = queues.find(q => q.label === 'webhook-delivery')!;
    expect(webhook.approximateMessageCount).toBe(3);
    expect(webhook.logGroups).toEqual(['/aws/lambda/app-stage-WebhookConsumer']);
    expect(
      webhook.logsUrl!.startsWith('https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#')
    ).toBe(true);
    expect(webhook.logsUrl).toContain('ABSOLUTE');
  });

  it('returns null log fields when the consumer cannot be resolved', async () => {
    const { queues } = await list();

    expect(queues.find(q => q.label === 'image-edit')).toMatchObject({ logGroups: null, logsUrl: null });
  });

  it('falls back to -1 for a queue whose DLQ URL is missing, without failing the list', async () => {
    h.getDlqUrl.mockImplementation((label: string) => {
      if (label === 'image-edit') throw new Error('Missing DLQ URL for label: image-edit');
      return `https://sqs.example/${label}-dlq`;
    });

    const { queues } = await list();

    expect(queues.find(q => q.label === 'image-edit')!.approximateMessageCount).toBe(-1);
    expect(queues.find(q => q.label === 'webhook-delivery')!.approximateMessageCount).toBe(3);
  });

  it('keeps the log fields when the queue attributes fail', async () => {
    h.getQueueAttributes.mockRejectedValue(new Error('throttled'));

    const { queues } = await list();

    const webhook = queues.find(q => q.label === 'webhook-delivery')!;
    expect(webhook.approximateMessageCount).toBe(-1);
    expect(webhook.logGroups).toEqual(['/aws/lambda/app-stage-WebhookConsumer']);
    expect(webhook.logsUrl).toEqual(expect.any(String));
  });

  it('carries no account id in the response', async () => {
    const body = await list();

    expect(JSON.stringify(body)).not.toMatch(/\d{12}/);
  });
});
