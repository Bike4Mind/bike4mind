// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handler: undefined as undefined | Handler,
  routeOptions: undefined as unknown,
  counts: {} as Record<string, number | Error>,
  inFlight: {} as Record<string, number>,
  messages: {} as Record<string, Array<Record<string, unknown>> | Error>,
  restricted: new Set<string>(),
  browse: vi.fn(),
  findFailures: vi.fn(),
  countAttempts: vi.fn(),
  recommend: vi.fn(),
  scheduleFacts: vi.fn(),
  logsUrl: vi.fn(),
  functionLogGroup: vi.fn(),
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
  getDlqRegistry: () =>
    [
      {
        label: 'billing',
        sourceQueue: 'billingQueue',
        describe: (body: { invoiceId?: string }) => (body.invoiceId ? { type: 'Invoice', id: body.invoiceId } : null),
      },
      { label: 'files', sourceQueue: 'filesQueue' },
      { label: 'empty', sourceQueue: 'emptyQueue' },
      { label: 'broken', sourceQueue: null },
      { label: 'offstage', sourceQueue: 'cronQueue' },
    ].map(entry => ({ ...entry, restrictedBody: h.restricted.has(entry.label) })),
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
    return {
      approximateMessageCount: count ?? 0,
      approximateNotVisibleCount: h.inFlight[url.slice('dlq:'.length)] ?? 0,
    };
  },
}));
vi.mock('@bike4mind/server-utils/utils/dlqMessages', () => ({
  browseDlqMessages: h.browse,
  findDlqFailures: h.findFailures,
  countDlqReplayAttempts: h.countAttempts,
  recommendForDlqMessage: h.recommend,
  messageLogsUrl: h.logsUrl,
}));
vi.mock('@bike4mind/server-utils/utils/dlqConsumerLogs', () => ({
  CONSUMER_LOGS_BUDGET_MS: 10,
  resolveConsumerLogsForSourceQueue: async () => null,
  resolveFunctionLogGroup: h.functionLogGroup,
  settleWithinBudget: async (lookups: Promise<unknown>[]) => Promise.all(lookups),
}));
vi.mock('@bike4mind/server-utils/utils/dlqMessageRow', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/dlqMessageRow')>()),
  resolveDlqScheduleFacts: h.scheduleFacts,
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), warn: vi.fn() } }));

import '../all-messages';

const sqsMessage = (id: string, sent: number, body = '{}') => ({
  MessageId: id,
  Body: body,
  Attributes: { SentTimestamp: String(sent), ApproximateReceiveCount: '2' },
});

async function call(user: Record<string, unknown> = { id: 'admin-1' }) {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as Record<string, unknown>).user = user;
  await h.handler!(req, res);
  return res._getJSONData();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.counts = { billing: 2, files: 1, empty: 0, broken: 1 };
  h.inFlight = {};
  h.restricted = new Set();
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
  h.scheduleFacts.mockResolvedValue(new Map());
  h.logsUrl.mockReturnValue(null);
  h.functionLogGroup.mockImplementation(async (_region: string, fn: string) => `/sst/app/stage/${fn.split(':').pop()}`);
  vi.stubEnv('AWS_REGION', 'us-east-2');
  h.findFailures.mockResolvedValue({ failures: [], lookupFailed: false });
  h.countAttempts.mockResolvedValue(null);
  h.recommend.mockImplementation((facts: { replayAttempts?: number }) => ({
    action: 'inspect',
    label: 'Inspect first',
    basis: `attempts=${facts.replayAttempts ?? 'unknown'}`,
  }));
});

afterEach(() => vi.unstubAllEnvs());

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

  it('withholds a restricted queue body from a delegated admin and keeps other queues readable', async () => {
    h.restricted = new Set(['billing']);
    h.messages.billing = [sqsMessage('b-new', 300, '{"to":"a@example.com","code":"123456"}')];
    h.messages.files = [sqsMessage('f-mid', 200, '{"work":"visible"}')];
    const { messages } = await call({ id: 'admin-1', isAdmin: false });
    const byId = (id: string) => messages.find((m: { messageId: string }) => m.messageId === id);
    expect(byId('b-new')).toMatchObject({ body: '', bodyWithheld: true });
    expect(JSON.stringify(byId('b-new'))).not.toContain('123456');
    expect(byId('f-mid').body).toBe('{"work":"visible"}');
    expect(byId('f-mid')).not.toHaveProperty('bodyWithheld');
  });

  it('shows a restricted queue body to a full admin', async () => {
    h.restricted = new Set(['billing']);
    h.messages.billing = [sqsMessage('b-new', 300, '{"to":"a@example.com","code":"123456"}')];
    const { messages } = await call({ id: 'admin-1', isAdmin: true });
    const row = messages.find((m: { messageId: string }) => m.messageId === 'b-new');
    expect(row.body).toContain('123456');
    expect(row).not.toHaveProperty('bodyWithheld');
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

  it('passes each queue its depth, so schedule facts can tell a partial listing', async () => {
    h.counts.files = new Error('throttled');
    await call();
    const depthByQueue = Object.fromEntries(
      h.scheduleFacts.mock.calls.map(([entry, messages, depth]) => [entry.label, [messages.length, depth]])
    );
    expect(depthByQueue).toEqual({ billing: [2, 2], files: [1, -1] });
  });

  it('counts in-flight messages in the depth passed to schedule facts', async () => {
    h.inFlight.billing = 1;
    await call();
    const billing = h.scheduleFacts.mock.calls.find(([entry]) => entry.label === 'billing');
    expect(billing?.[2]).toBe(3);
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

  it('attributes a failure from EventBridge message attributes when none was recorded', async () => {
    h.messages.files = [
      {
        ...sqsMessage('f-mid', 200),
        MessageAttributes: {
          ERROR_CODE: { DataType: 'String', StringValue: 'SDK_CLIENT_ERROR' },
          ERROR_MESSAGE: { DataType: 'String', StringValue: 'Lambda throttled' },
        },
      },
    ];
    const { messages } = await call();
    const row = messages.find((m: { messageId: string }) => m.messageId === 'f-mid');
    expect(row.failure).toEqual({
      errorMessage: 'Lambda throttled',
      category: 'unknown',
      source: 'attributes',
      errorCode: 'SDK_CLIENT_ERROR',
    });
    expect(messages.find((m: { messageId: string }) => m.messageId === 'b-new').failure).toBeUndefined();
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
    expect(byId('b-new').failure).toEqual({ errorMessage: 'card declined', category: 'refused', source: 'recorded' });
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

  it('passes a schedule target log group to the logs link', async () => {
    h.messages = { billing: [sqsMessage('b-new', 300)] };
    h.scheduleFacts.mockResolvedValue(
      new Map([
        [
          'b-new',
          { scheduledAt: '2026-01-02T03:00:00.000Z', logTarget: { region: 'us-east-2', logGroup: '/sst/app/Nightly' } },
        ],
      ])
    );
    await call();
    expect(h.logsUrl).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleLogs: { region: 'us-east-2', logGroup: '/sst/app/Nightly' } })
    );
  });

  it('resolves an EventBridge TARGET_ARN to its function log group for the logs link', async () => {
    const targetArn = ['arn', 'aws', 'lambda', 'us-east-2', '0'.repeat(12), 'function', 'app-stage-Consumer'].join(':');
    h.messages = {
      billing: [
        {
          ...sqsMessage('b-new', 300),
          MessageAttributes: {
            ERROR_CODE: { DataType: 'String', StringValue: 'SDK_CLIENT_ERROR' },
            TARGET_ARN: { DataType: 'String', StringValue: targetArn },
          },
        },
      ],
    };
    await call();
    expect(h.functionLogGroup).toHaveBeenCalledWith('us-east-2', targetArn, expect.any(Number));
    expect(h.logsUrl).toHaveBeenCalledWith(
      expect.objectContaining({ targetLogs: { region: 'us-east-2', logGroup: '/sst/app/stage/app-stage-Consumer' } })
    );
  });

  it('leaves out the TARGET_ARN log group when its lookup fails', async () => {
    h.functionLogGroup.mockResolvedValue(null);
    h.messages = {
      billing: [
        {
          ...sqsMessage('b-new', 300),
          MessageAttributes: {
            ERROR_CODE: { DataType: 'String', StringValue: 'SDK_CLIENT_ERROR' },
            TARGET_ARN: {
              DataType: 'String',
              StringValue: ['arn', 'aws', 'lambda', 'us-east-2', '0'.repeat(12), 'function', 'fn'].join(':'),
            },
          },
        },
      ],
    };
    await call();
    expect(h.logsUrl).toHaveBeenCalledWith(expect.objectContaining({ targetLogs: undefined }));
  });
});
