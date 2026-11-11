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
    expect(contributed).toMatchObject({ displayName: 'Contributed', approximateMessageCount: 3 });
    expect(contributed).not.toHaveProperty('description');
    expect(contributed).not.toHaveProperty('replay');
  });
});
