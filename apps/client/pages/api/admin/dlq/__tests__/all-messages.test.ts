// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handler: undefined as undefined | Handler,
  routeOptions: undefined as unknown,
  counts: {} as Record<string, number | Error>,
  messages: {} as Record<string, Array<Record<string, unknown>> | Error>,
  browse: vi.fn(),
  findFailures: vi.fn(),
  countAttempts: vi.fn(),
  recommend: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.routeOptions = options;
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
      label: 'billing',
      sourceQueue: 'billingQueue',
      describe: (body: { invoiceId?: string }) => (body.invoiceId ? { type: 'Invoice', id: body.invoiceId } : null),
    },
    { label: 'files', sourceQueue: 'filesQueue' },
    { label: 'empty', sourceQueue: 'emptyQueue' },
    { label: 'broken', sourceQueue: null },
    { label: 'offstage', sourceQueue: 'cronQueue' },
  ],
  getDlqUrl: (label: string) => {
    if (label === 'offstage') throw new Error('Queue not linked on this stage');
    return `dlq:${label}`;
  },
  describeDlqMessage: (entry: { describe?: (body: unknown) => unknown }, raw: string) =>
    entry.describe ? entry.describe(JSON.parse(raw)) : null,
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  getQueueAttributes: async (url: string) => {
    const count = h.counts[url.slice('dlq:'.length)];
    if (count instanceof Error) throw count;
    return { approximateMessageCount: count ?? 0, approximateNotVisibleCount: 0 };
  },
}));
vi.mock('@bike4mind/server-utils/utils/dlqMessages', () => ({
  browseDlqMessages: h.browse,
  findDlqFailures: h.findFailures,
  countDlqReplayAttempts: h.countAttempts,
  recommendForDlqMessage: h.recommend,
  messageLogsUrl: () => null,
}));
vi.mock('@bike4mind/server-utils/utils/dlqConsumerLogs', () => ({
  CONSUMER_LOGS_BUDGET_MS: 10,
  resolveConsumerLogsForSourceQueue: async () => null,
  settleWithinBudget: async (lookups: Promise<unknown>[]) => Promise.all(lookups),
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), warn: vi.fn() } }));

import '../all-messages';

const sqsMessage = (id: string, sent: number, body = '{}') => ({
  MessageId: id,
  Body: body,
  Attributes: { SentTimestamp: String(sent), ApproximateReceiveCount: '2' },
});

async function call() {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1' };
  await h.handler!(req, res);
  return res._getJSONData();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.counts = { billing: 2, files: 1, empty: 0, broken: 1 };
  h.messages = {
    billing: [sqsMessage('b-old', 100, '{"invoiceId":"in_1"}'), sqsMessage('b-new', 300)],
    files: [sqsMessage('f-mid', 200)],
    broken: new Error('AccessDenied'),
  };
  h.browse.mockImplementation(async (url: string) => {
    const messages = h.messages[url.slice('dlq:'.length)];
    if (messages instanceof Error) throw messages;
    return messages ?? [];
  });
  h.findFailures.mockResolvedValue({ failures: [], lookupFailed: false });
  h.countAttempts.mockResolvedValue(null);
  h.recommend.mockImplementation((facts: { replayAttempts?: number }) => ({
    action: 'inspect',
    label: 'Inspect first',
    basis: `attempts=${facts.replayAttempts ?? 'unknown'}`,
  }));
});

describe('GET /api/admin/dlq/all-messages', () => {
  it('is readable with support:read, by a signed-in admin only', () => {
    expect(h.routeOptions).toMatchObject({ adminPermissions: { GET: 'support:read' }, auth: 'jwtOnly' });
  });

  it('merges every queue into one list, newest first, tagged with its queue', async () => {
    const { messages } = await call();
    expect(messages.map((m: { messageId: string; queueLabel: string }) => [m.messageId, m.queueLabel])).toEqual([
      ['b-new', 'billing'],
      ['f-mid', 'files'],
      ['b-old', 'billing'],
    ]);
  });

  it('describes each message with its queue describe, or null', async () => {
    const { messages } = await call();
    const entity = (id: string) => messages.find((m: { messageId: string }) => m.messageId === id).entity;
    expect(entity('b-old')).toEqual({ type: 'Invoice', id: 'in_1' });
    expect(entity('b-new')).toBeNull();
    expect(entity('f-mid')).toBeNull();
  });

  it('skips queues known to be empty and reports listed counts per queue', async () => {
    const { queues } = await call();
    expect(h.browse).not.toHaveBeenCalledWith('dlq:empty', expect.anything());
    expect(queues).toEqual([
      { label: 'billing', approximateMessageCount: 2, listed: 2, failed: false },
      { label: 'files', approximateMessageCount: 1, listed: 1, failed: false },
      { label: 'empty', approximateMessageCount: 0, listed: 0, failed: false },
      { label: 'broken', approximateMessageCount: 1, listed: 0, failed: true },
      { label: 'offstage', approximateMessageCount: -1, listed: 0, failed: false },
    ]);
  });

  it('neither browses nor fails a queue this stage does not create', async () => {
    await call();
    expect(h.browse).not.toHaveBeenCalledWith(expect.stringContaining('offstage'), expect.anything());
  });

  it('still browses a queue whose count could not be read', async () => {
    h.counts.files = new Error('throttled');
    const { queues, messages } = await call();
    expect(h.browse).toHaveBeenCalledWith('dlq:files', expect.anything());
    expect(queues.find((q: { label: string }) => q.label === 'files')).toMatchObject({
      approximateMessageCount: -1,
      listed: 1,
    });
    expect(messages).toHaveLength(3);
  });

  it('attaches recorded failures and flags a failed lookup', async () => {
    h.findFailures.mockImplementation(async (label: string) =>
      label === 'billing'
        ? {
            failures: [{ messageId: 'b-new', errorMessage: 'card declined', category: 'refused' }],
            lookupFailed: false,
          }
        : { failures: [], lookupFailed: true }
    );
    const { messages } = await call();
    const byId = (id: string) => messages.find((m: { messageId: string }) => m.messageId === id);
    expect(byId('b-new').failure).toEqual({ errorMessage: 'card declined', category: 'refused' });
    expect(byId('b-old').failureLookupFailed).toBeUndefined();
    expect(byId('f-mid').failureLookupFailed).toBe(true);
  });

  it('recommends a next step per message from its failure and recorded replay attempts', async () => {
    h.findFailures.mockImplementation(async (label: string) =>
      label === 'billing'
        ? { failures: [{ messageId: 'b-new', errorMessage: 'slow', category: 'timeout' }], lookupFailed: false }
        : { failures: [], lookupFailed: false }
    );
    h.countAttempts.mockImplementation(async (label: string) => (label === 'billing' ? new Map([['b-new', 2]]) : null));
    const { messages } = await call();
    const byId = (id: string) => messages.find((m: { messageId: string }) => m.messageId === id);
    expect(h.countAttempts).toHaveBeenCalledWith('billing', ['b-old', 'b-new']);
    expect(h.recommend).toHaveBeenCalledWith(
      expect.objectContaining({ failure: expect.objectContaining({ category: 'timeout' }), replayAttempts: 2 })
    );
    expect(byId('b-new').recommendation).toMatchObject({ basis: 'attempts=2' });
    expect(byId('f-mid').recommendation).toMatchObject({ basis: 'attempts=unknown' });
  });
});
