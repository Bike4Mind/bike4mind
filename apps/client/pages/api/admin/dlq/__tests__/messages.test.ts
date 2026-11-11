// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handler: undefined as undefined | Handler,
  receiveFromQueue: vi.fn(),
  findForMessages: vi.fn(),
  sourceQueue: 'source' as string | null,
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
  getDlqByLabel: (label: string) => ({ label, sourceQueue: h.sourceQueue, replay: 'unsafe' }),
  getDlqUrl: () => 'https://sqs.example/dlq',
  getSourceQueueUrl: () => 'https://sqs.example/physical-source',
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ receiveFromQueue: h.receiveFromQueue }));
vi.mock('@bike4mind/database', () => ({ dlqFailureRepository: { findForMessages: h.findForMessages } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), warn: vi.fn() } }));

import '../messages';

const message = { MessageId: 'm1', Body: '{}', ReceiptHandle: 'handle-1', Attributes: {} };

const peek = async (adminPermissions: string[]) => {
  const res = { json: vi.fn() };
  await h.handler!({ query: { queue: 'q1' }, user: { id: 'u1', isAdmin: false, adminPermissions } }, res);
  return res.json.mock.calls[0][0] as {
    messages: Array<{
      messageId?: string;
      body?: string;
      receiptHandle?: string;
      approximateReceiveCount?: string;
      failureLookupFailed?: boolean;
      failure?: { errorMessage: string; category: string };
    }>;
  };
};

describe('GET /api/admin/dlq/messages', () => {
  beforeEach(() => {
    h.receiveFromQueue.mockReset().mockResolvedValue([message]);
    h.findForMessages.mockReset().mockResolvedValue([]);
    h.sourceQueue = 'source';
  });

  it('keeps an unsafe queue inspectable for a settings:manage caller', async () => {
    h.sourceQueue = null;
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
  });

  it.each([
    ['settings:manage', 120, 'handle-1'],
    ['support:read', 0, undefined],
  ])(
    'preserves the SQS peek for %s when failure details are unavailable',
    async (permission, visibility, receiptHandle) => {
      h.findForMessages.mockRejectedValue(new Error('private diagnostic failure'));
      const body = await peek([permission]);
      expect(h.receiveFromQueue).toHaveBeenCalledWith('https://sqs.example/dlq', 10, visibility);
      expect(h.findForMessages).toHaveBeenCalledWith('physical-source', ['m1']);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]).toMatchObject({ messageId: 'm1', body: '{}', failureLookupFailed: true });
      expect(body.messages[0].receiptHandle).toBe(receiptHandle);
      expect(body.messages[0].failure).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('private diagnostic failure');
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
