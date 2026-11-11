// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type * as DlqRegistryModule from '@bike4mind/server-utils/utils/dlqRegistry';

const h = vi.hoisted(() => ({
  getQueueAttributes: vi.fn(),
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
    getDlqUrl: (label: string) => `https://sqs.example.com/${label}`,
  };
});
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => {
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
  await import('../queues');
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
