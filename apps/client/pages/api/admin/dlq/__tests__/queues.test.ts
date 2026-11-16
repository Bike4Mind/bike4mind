// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type * as DlqRegistryModule from '@bike4mind/server-utils/utils/dlqRegistry';

const h = vi.hoisted(() => ({
  getQueueAttributes: vi.fn(),
  getDlqUrl: vi.fn(),
  resolveConsumerLogsForSourceQueue: vi.fn(),
  adminPermissions: undefined as undefined | Record<string, string>,
  registry: undefined as readonly unknown[] | undefined,
  get: undefined as ((req: unknown, res: unknown) => Promise<void>) | undefined,
}));

vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/common', () => ({ ApiKeyScope: { ADMIN: 'admin' } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  BadRequestError: class BadRequestError extends Error {},
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ getQueueAttributes: h.getQueueAttributes }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', async importOriginal => {
  const actual = await importOriginal<typeof DlqRegistryModule>();
  return {
    ...actual,
    getDlqRegistry: () => h.registry ?? actual.coreDlqDescriptors(),
    getDlqUrl: h.getDlqUrl,
  };
});
vi.mock('@bike4mind/server-utils/utils/dlqConsumerLogs', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/dlqConsumerLogs')>()),
  resolveConsumerLogsForSourceQueue: h.resolveConsumerLogsForSourceQueue,
}));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options?: { adminPermissions?: Record<string, string> }) => {
    h.adminPermissions = options?.adminPermissions;
    const chain = {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => Promise<void>) => {
        h.get = fn;
        return chain;
      },
    };
    return chain;
  },
}));

const { coreDlqDescriptors } = await vi.importActual<typeof DlqRegistryModule>(
  '@bike4mind/server-utils/utils/dlqRegistry'
);

type QueueBody = { queues: Array<Record<string, unknown>> };

async function callRoute(): Promise<QueueBody> {
  const { req, res } = createMocks({ method: 'GET', query: {} });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await h.get!(req, res);
  return JSON.parse(res._getData()) as QueueBody;
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.registry = undefined;
  h.getQueueAttributes.mockResolvedValue({ approximateMessageCount: 3, approximateNotVisibleCount: 0 });
  h.getDlqUrl.mockImplementation((label: string) => `https://sqs.example.com/${label}`);
  h.resolveConsumerLogsForSourceQueue.mockResolvedValue(null);
  await import('../queues');
});

const CONSUMER_LOGS_REGISTRY = [
  {
    label: 'webhook-delivery',
    displayName: 'Webhook Delivery',
    application: 'Webhooks',
    sourceQueue: 'webhookDeliveryQueue',
  },
  { label: 'image-edit', displayName: 'Image Edit', application: 'ImageGeneration', sourceQueue: 'imageEditQueue' },
];

type QueueRow = {
  label: string;
  deployed?: boolean;
  approximateMessageCount: number;
  logGroups: string[] | null;
  logsUrl: string | null;
};

const list = async () => {
  const res = { json: vi.fn() };
  await h.get!({ user: { id: 'u1' } }, res);
  return res.json.mock.calls[0][0] as { queues: QueueRow[] };
};

const webhookLogs = {
  region: 'us-east-2',
  logGroups: ['/aws/lambda/app-stage-WebhookConsumer'],
  retryWindowMs: 3_600_000,
};

describe('GET /api/admin/dlq/queues consumer logs', () => {
  beforeEach(() => {
    h.registry = CONSUMER_LOGS_REGISTRY;
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

  it('marks a queue with no DLQ URL on this stage as not deployed, without failing the list', async () => {
    h.getDlqUrl.mockImplementation((label: string) => {
      if (label === 'image-edit') throw new Error('Missing DLQ URL for label: image-edit');
      return `https://sqs.example/${label}-dlq`;
    });

    const { queues } = await list();

    expect(queues.find(q => q.label === 'image-edit')).toMatchObject({ deployed: false, approximateMessageCount: -1 });
    expect(h.getQueueAttributes).not.toHaveBeenCalledWith(expect.stringContaining('image-edit'));
    const webhook = queues.find(q => q.label === 'webhook-delivery')!;
    expect(webhook.approximateMessageCount).toBe(3);
    expect(webhook.deployed).toBeUndefined();
  });

  it('keeps the log fields when the queue attributes fail', async () => {
    h.getQueueAttributes.mockRejectedValue(new Error('throttled'));

    const { queues } = await list();

    const webhook = queues.find(q => q.label === 'webhook-delivery')!;
    expect(webhook.approximateMessageCount).toBe(-1);
    // A failed read on a queue that exists is not "not deployed": it must still block the all-clear.
    expect(webhook.deployed).toBeUndefined();
    expect(webhook.logGroups).toEqual(['/aws/lambda/app-stage-WebhookConsumer']);
    expect(webhook.logsUrl).toEqual(expect.any(String));
  });

  it('carries no account id in the response', async () => {
    const body = await list();

    expect(JSON.stringify(body)).not.toMatch(/\d{12}/);
  });
});

describe('GET /api/admin/dlq/queues', () => {
  it('returns description, replay, replayNote and owner for every core queue, including one whose attributes fail', async () => {
    const core = coreDlqDescriptors();
    const failingLabel = core[1].label;
    h.getQueueAttributes.mockImplementation(async (url: string) => {
      if (url.endsWith(`/${failingLabel}`)) throw new Error('AccessDenied');
      return { approximateMessageCount: 3, approximateNotVisibleCount: 0 };
    });

    const { queues } = await callRoute();

    expect(queues).toHaveLength(core.length);
    for (const entry of core) {
      const queue = queues.find(q => q.label === entry.label);
      expect(queue, entry.label).toMatchObject({
        description: entry.description,
        replay: entry.replay,
        replayNote: entry.replayNote,
        owner: entry.owner,
        hasReplayDestination: entry.sourceQueue !== null,
      });
      for (const key of ['description', 'replayNote', 'owner'] as const) {
        expect(String(queue?.[key]).trim(), `${entry.label}.${key}`).not.toBe('');
      }
      expect(['safe', 'side-effects', 'unsafe'], `${entry.label}.replay`).toContain(queue?.replay);
    }
    expect(queues.find(q => q.label === failingLabel)).toMatchObject({
      approximateMessageCount: -1,
      description: core[1].description,
    });
  });

  it('returns a contributed queue without help fields', async () => {
    h.registry = [
      ...coreDlqDescriptors(),
      { label: 'contributed-dlq', displayName: 'Contributed', application: 'Extras', sourceQueue: 'contributed' },
    ];

    const { queues } = await callRoute();

    const contributed = queues.find(q => q.label === 'contributed-dlq');
    expect(contributed).toMatchObject({
      displayName: 'Contributed',
      approximateMessageCount: 3,
      hasReplayDestination: true,
    });
    expect(contributed).not.toHaveProperty('description');
    expect(contributed).not.toHaveProperty('replay');
  });

  describe('message retention', () => {
    beforeEach(() => {
      h.registry = [
        { label: 'short-dlq', displayName: 'Short', application: 'app', sourceQueue: 'short' },
        { label: 'long-dlq', displayName: 'Long', application: 'app', sourceQueue: 'long' },
        { label: 'broken-dlq', displayName: 'Broken', application: 'app', sourceQueue: 'broken' },
      ];
      h.getQueueAttributes.mockImplementation(async (url: string) => {
        if (url.endsWith('broken-dlq')) throw new Error('SQS unreachable');
        return {
          approximateMessageCount: 2,
          approximateNotVisibleCount: 0,
          messageRetentionSeconds: url.endsWith('short-dlq') ? 345600 : 1209600,
        };
      });
    });

    it('returns each queue with its own message retention', async () => {
      const { queues } = await callRoute();

      expect(queues.find(q => q.label === 'short-dlq')?.messageRetentionSeconds).toBe(345600);
      expect(queues.find(q => q.label === 'long-dlq')?.messageRetentionSeconds).toBe(1209600);
    });

    it('returns a queue whose attributes failed to load without retention', async () => {
      const broken = (await callRoute()).queues.find(q => q.label === 'broken-dlq');

      expect(broken?.approximateMessageCount).toBe(-1);
      expect(broken?.messageRetentionSeconds).toBeUndefined();
    });
  });

  it.each([false, true])('lists unsafe queues and their safety even when attributes fail: %s', async fail => {
    h.registry = [
      { label: 'events', displayName: 'Events', application: 'Example', sourceQueue: null, replay: 'unsafe' },
    ];
    h.getQueueAttributes.mockReset().mockResolvedValue({
      approximateMessageCount: 2,
      approximateNotVisibleCount: 0,
      messageRetentionSeconds: 1209600,
    });
    if (fail) h.getQueueAttributes.mockRejectedValue(new Error('Unavailable'));
    const events = (await callRoute()).queues.find(q => q.label === 'events');

    expect(events).toMatchObject({
      label: 'events',
      displayName: 'Events',
      application: 'Example',
      replay: 'unsafe',
      hasReplayDestination: false,
      approximateMessageCount: fail ? -1 : 2,
      approximateNotVisibleCount: fail ? -1 : 0,
    });
    expect(events?.messageRetentionSeconds).toBe(fail ? undefined : 1209600);
    expect(h.getQueueAttributes).toHaveBeenCalledWith('https://sqs.example.com/events');
  });
});
