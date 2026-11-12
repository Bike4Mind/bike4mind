// @vitest-environment node
import { Logger } from '@bike4mind/observability';
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handler: undefined as undefined | Handler,
  receiveFromQueue: vi.fn(),
  resolveConsumerLogsForSourceQueue: vi.fn(),
  findForMessages: vi.fn(),
  countAttempts: vi.fn(),
  sourceQueue: 'webhookDeliveryQueue' as string | null,
  replaySafety: 'unsafe',
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
  getDlqByLabel: (label: string) =>
    label === 'q1' ? { label, sourceQueue: h.sourceQueue, replay: h.replaySafety } : undefined,
  getDlqUrl: () => 'https://sqs.example/dlq',
  getSourceQueueUrl: () => 'https://sqs.example/physical-source',
}));
vi.mock('@bike4mind/server-utils/utils/dlqConsumerLogs', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/dlqConsumerLogs')>()),
  resolveConsumerLogsForSourceQueue: h.resolveConsumerLogsForSourceQueue,
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ receiveFromQueue: h.receiveFromQueue }));
vi.mock('@bike4mind/database', () => ({
  dlqFailureRepository: { findForMessages: h.findForMessages },
  dlqReplayLogRepository: { countAttempts: h.countAttempts },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), warn: vi.fn() } }));

import { CONSUMER_LOGS_BUDGET_MS } from '@bike4mind/server-utils/utils/dlqConsumerLogs';
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
      failureLookupFailed?: boolean;
      failure?: { errorMessage: string; category: string };
      recommendation: { action: string; label: string; basis: string };
    }>;
  };
};

// The console hash double-encodes: '$' stands for '%' in the outer layer, '*' in the inner one.
const decodeConsoleUrl = (url: string) =>
  decodeURIComponent(decodeURIComponent(url.split('#')[1].replace(/\$/g, '%')).replace(/\*/g, '%'));

describe('GET /api/admin/dlq/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.replaySafety = 'unsafe';
    h.receiveFromQueue.mockReset().mockResolvedValue([message]);
    h.resolveConsumerLogsForSourceQueue.mockReset().mockResolvedValue(consumerLogs);
    h.findForMessages.mockReset().mockResolvedValue([]);
    h.countAttempts.mockReset().mockResolvedValue(0);
    h.sourceQueue = 'webhookDeliveryQueue';
  });

  it('keeps an unsafe queue inspectable, visible and without receipt handles for a settings:manage caller', async () => {
    h.sourceQueue = null;
    const body = await peek(['settings:manage']);

    expect(h.receiveFromQueue).toHaveBeenCalledWith('https://sqs.example/dlq', 10, 0);
    expect(body.messages[0]).not.toHaveProperty('receiptHandle');
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

  it('returns messages without logs links when the consumer lookup outlasts its budget', async () => {
    vi.useFakeTimers();
    try {
      h.resolveConsumerLogsForSourceQueue.mockReturnValue(new Promise(() => {}));
      h.receiveFromQueue.mockResolvedValue([
        { MessageId: 'm1', Attributes: { SentTimestamp: String(1_767_322_800_000) } },
      ]);

      const pending = peek(['support:read']);
      await vi.advanceTimersByTimeAsync(CONSUMER_LOGS_BUDGET_MS);
      const body = await pending;

      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].logsUrl).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an unknown queue before any AWS call', async () => {
    await expect(peek(['support:read'], 'nope')).rejects.toThrow('Unknown DLQ: nope');

    expect(h.receiveFromQueue).not.toHaveBeenCalled();
    expect(h.resolveConsumerLogsForSourceQueue).not.toHaveBeenCalled();
  });

  it('joins failure metadata by physical source queue and message id without exposing other fields', async () => {
    h.findForMessages.mockResolvedValue([
      { messageId: 'm1', errorMessage: 'worker timed out', category: 'timeout', consumerVersion: 'secret-version' },
    ]);
    const body = await peek(['support:read']);
    expect(h.findForMessages).toHaveBeenCalledWith('physical-source', ['m1']);
    expect(body.messages[0].failure).toEqual({ errorMessage: 'worker timed out', category: 'timeout' });
    expect(body.messages[0]).not.toHaveProperty('consumerVersion');
  });

  it('leaves the failure absent for historical messages', async () => {
    const row = (await peek(['support:read'])).messages[0];
    expect(row.failure).toBeUndefined();
    expect(row.failureLookupFailed).toBeUndefined();
    expect(row.recommendation.action).toBe('inspect');
  });

  it('joins recorded failures, consumer deployment and replay attempts into advisory recommendations', async () => {
    h.findForMessages.mockResolvedValue([{ messageId: 'm1', category: 'bug', failedAt: new Date('2026-01-01') }]);
    h.resolveConsumerLogsForSourceQueue.mockResolvedValue({
      ...consumerLogs,
      consumerDeployedAt: '2026-01-02T00:00:00Z',
    });
    expect((await peek(['support:read'])).messages[0].recommendation.label).toBe('Fix first');
    h.countAttempts.mockResolvedValue(3);
    expect((await peek(['support:read'])).messages[0].recommendation).toMatchObject({
      action: 'discard',
      basis: expect.stringContaining('3 recorded replay attempts'),
    });
    h.countAttempts.mockRejectedValue(new Error('private lookup error'));
    expect((await peek(['support:read'])).messages[0].recommendation.label).toBe('Fix first');
  });

  it.each(['settings:manage', 'support:read'])(
    'preserves the SQS peek for %s when failure details are unavailable',
    async permission => {
      h.findForMessages.mockRejectedValue(new Error('private diagnostic failure'));
      const body = await peek([permission]);
      expect(h.receiveFromQueue).toHaveBeenCalledWith('https://sqs.example/dlq', 10, 0);
      expect(h.findForMessages).toHaveBeenCalledWith('physical-source', ['m1']);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]).toMatchObject({ messageId: 'm1', body: '{}', failureLookupFailed: true });
      expect(body.messages[0]).not.toHaveProperty('receiptHandle');
      expect(body.messages[0].failure).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('private diagnostic failure');
    }
  );

  it('starts attempt metadata while the independent failure lookup is still pending', async () => {
    let release!: (value: never[]) => void;
    h.findForMessages.mockReturnValue(
      new Promise<never[]>(resolve => {
        release = resolve;
      })
    );
    const pending = peek(['support:read']);
    try {
      await vi.waitFor(() => expect(h.countAttempts).toHaveBeenCalledWith('m1'));
    } finally {
      release([]);
      await pending;
    }
  });
  it('keeps the row and unknown-count advice when attempt lookup exceeds its budget', async () => {
    vi.useFakeTimers();
    try {
      h.replaySafety = 'safe';
      h.findForMessages.mockResolvedValue([{ messageId: 'm1', category: 'timeout', errorType: 'Error' }]);
      h.countAttempts.mockReturnValue(new Promise(() => {}));
      const pending = peek(['support:read']);
      await vi.advanceTimersByTimeAsync(CONSUMER_LOGS_BUDGET_MS);
      const row = (await pending).messages[0];
      expect(row.messageId).toBe('m1');
      expect(row.recommendation).toMatchObject({
        action: 'inspect',
        basis: expect.stringContaining('attempt count is unavailable'),
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('bounds a stalled failure read and preserves visible messages', async () => {
    vi.useFakeTimers();
    try {
      h.findForMessages.mockReturnValue(new Promise(() => {}));
      const pending = peek(['support:read']);
      await vi.advanceTimersByTimeAsync(CONSUMER_LOGS_BUDGET_MS);
      expect((await pending).messages[0]).toMatchObject({
        messageId: 'm1',
        failureLookupFailed: true,
        recommendation: { action: 'inspect' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('logs rejected attempt metadata by error name without copying diagnostics', async () => {
    h.replaySafety = 'safe';
    h.findForMessages.mockResolvedValue([{ messageId: 'm1', category: 'timeout', errorType: 'Error' }]);
    h.countAttempts.mockRejectedValue(
      Object.assign(new Error('private diagnostic content'), { name: 'MetadataUnavailable' })
    );
    expect((await peek(['support:read'])).messages[0].recommendation.action).toBe('inspect');
    expect(Logger.warn).toHaveBeenCalledWith('[DLQ Messages] Replay attempts unavailable', {
      queueLabel: 'q1',
      errorName: 'MetadataUnavailable',
    });
    expect(JSON.stringify(vi.mocked(Logger.warn).mock.calls)).not.toContain('private diagnostic content');
  });
  it.each(['safe', 'side-effects', 'unsafe', 'future-class'])(
    'requires known queue safety for transient advice: %s',
    async safety => {
      h.replaySafety = safety;
      h.findForMessages.mockResolvedValue([{ messageId: 'm1', category: 'timeout', errorType: 'Error' }]);
      const advice = (await peek(['support:read'])).messages[0].recommendation;
      expect(advice.action).toBe(safety === 'safe' ? 'replay' : 'inspect');
      if (safety === 'safe') expect(advice.basis).toBe('Recorded transient failure: timeout.');
    }
  );

  it('still rejects an unsuccessful SQS peek', async () => {
    const error = new Error('SQS unavailable');
    h.receiveFromQueue.mockRejectedValue(error);
    await expect(peek(['support:read'])).rejects.toBe(error);
    expect(h.findForMessages).not.toHaveBeenCalled();
  });

  it('skips the optional lookup for an empty queue', async () => {
    h.receiveFromQueue.mockResolvedValue([]);
    expect((await peek(['support:read'])).messages).toEqual([]);
    expect(h.findForMessages).not.toHaveBeenCalled();
  });

  it('leaves uninstrumented alarm-only queues Unknown without resolving a source queue', async () => {
    h.sourceQueue = null;
    const row = (await peek(['support:read'])).messages[0];
    expect(row.failure).toBeUndefined();
    expect(row.failureLookupFailed).toBeUndefined();
    expect(h.findForMessages).not.toHaveBeenCalled();
  });
});
