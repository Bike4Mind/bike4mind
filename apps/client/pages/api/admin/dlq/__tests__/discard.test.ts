// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const h = vi.hoisted(() => ({
  post: undefined as ((req: unknown, res: unknown) => Promise<void>) | undefined,
  routeOptions: undefined as unknown,
  logReplay: vi.fn(),
  finalizeDiscard: vi.fn(),
  deleteFromQueue: vi.fn(),
  changeMessageVisibility: vi.fn(),
  audit: vi.fn(),
  acquire: vi.fn(),
  suggestion: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.routeOptions = options;
    return {
      post: (fn: typeof h.post) => {
        h.post = fn;
      },
    };
  },
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => {
  const queues: Record<string, { displayName: string; url: string }> = {
    quest: { displayName: 'Quest queue', url: 'dlq-url' },
    exports: { displayName: 'Export queue', url: 'exports-dlq-url' },
  };
  return {
    getDlqByLabel: (label: string) => (queues[label] ? { label, displayName: queues[label].displayName } : undefined),
    getDlqUrl: (label: string) => queues[label].url,
  };
});
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  deleteFromQueue: h.deleteFromQueue,
  changeMessageVisibility: h.changeMessageVisibility,
}));
vi.mock('@bike4mind/server-utils/utils/dlqMessages', () => ({ acquireDlqMessagesById: h.acquire }));
vi.mock('@bike4mind/database', () => ({
  dlqReplayLogRepository: { logReplay: h.logReplay, finalizeDiscard: h.finalizeDiscard },
  adminAiSuggestionRepository: { transition: h.transition },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/admin/dlq/triage', () => ({ visibleDlqSuggestion: h.suggestion }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  parseAdminActionReason: (value: unknown) => {
    if (typeof value !== 'string' || value.trim().length < 5) throw new BadRequestError('Reason required');
    return value.trim();
  },
  recordAdminActionFromRequest: h.audit,
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { error: vi.fn(), warn: vi.fn() } }));

import '../discard';

const request = (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  return { req, res };
};
const message = { messageId: 'm1', receiptHandle: 'receipt-1', body: '{"secret":"payload"}' };
const acquireMessages = (...found: Array<typeof message>) =>
  h.acquire.mockResolvedValue({
    found: found.map(m => ({ MessageId: m.messageId, ReceiptHandle: m.receiptHandle, Body: m.body })),
    notFound: [],
  });

beforeEach(() => {
  vi.clearAllMocks();
  acquireMessages(message);
  h.logReplay.mockResolvedValue({ id: 'log-1' });
  h.deleteFromQueue.mockResolvedValue(undefined);
  h.changeMessageVisibility.mockResolvedValue(undefined);
  h.finalizeDiscard.mockResolvedValue(undefined);
});

describe('POST /api/admin/dlq/discard', () => {
  it('claims and audits a matching suggestion before acquiring or deleting the message', async () => {
    const id = 'a'.repeat(24);
    h.suggestion.mockResolvedValue({
      id,
      proposedAction: {
        queueLabel: 'quest',
        messageId: 'm1',
        action: 'discard',
        risk: 'terminal-refusal',
        reason: 'Recorded refusal',
      },
    });
    h.transition.mockResolvedValueOnce({ id }).mockResolvedValue(null);
    h.acquire.mockResolvedValue({ found: [{ MessageId: 'm1', ReceiptHandle: 'fresh', Body: '{}' }], notFound: [] });
    const invoke = () => {
      const { req, res } = request({
        queueLabel: 'quest',
        messageIds: ['m1'],
        reason: 'Job obsolete',
        aiSuggestionId: id,
      });
      return h.post!(req, res);
    };
    await invoke();
    expect(h.transition).toHaveBeenCalledWith(id, ['pending'], 'accepted', {
      decidedBy: { userId: 'admin-1', name: undefined },
    });
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.dlq.triage.accepted',
      details: { aiSuggestionId: id },
    });
    expect(h.audit.mock.invocationCallOrder[0]).toBeLessThan(h.acquire.mock.invocationCallOrder[0]);
    expect(h.audit.mock.calls[1][1].details).toMatchObject({ aiSuggestionId: id });
    expect(h.logReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSuggestionId: id,
        messageId: 'm1',
        queueLabel: 'quest',
        operation: 'discard',
        status: 'pending',
      })
    );
    await expect(invoke()).rejects.toThrow('already been decided');
    expect(h.deleteFromQueue).toHaveBeenCalledOnce();
  });

  it('rejects a mismatched recommendation without acquiring or deleting', async () => {
    const id = 'a'.repeat(24);
    h.suggestion.mockResolvedValue({
      id,
      proposedAction: {
        queueLabel: 'quest',
        messageId: 'other',
        action: 'discard',
        risk: 'terminal-refusal',
        reason: 'Recorded refusal',
      },
    });
    const { req, res } = request({
      queueLabel: 'quest',
      messageIds: ['m1'],
      reason: 'Job obsolete',
      aiSuggestionId: id,
    });
    await expect(h.post!(req, res)).rejects.toThrow('does not match');
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.deleteFromQueue).not.toHaveBeenCalled();
  });

  it('requires a JWT and replay-equivalent permission', () => {
    expect(h.routeOptions).toMatchObject({ auth: 'jwtOnly', adminPermissions: { POST: 'settings:manage' } });
  });

  it('rejects a missing reason before writing or deleting', async () => {
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1'] });
    await expect(h.post!(req, res)).rejects.toThrow('Reason required');
    expect(h.logReplay).not.toHaveBeenCalled();
    expect(h.deleteFromQueue).not.toHaveBeenCalled();
  });

  it.each([
    ['whitespace-only reason', { queueLabel: 'quest', messageIds: ['m1'], reason: '     ' }],
    ['unknown queue', { queueLabel: 'nope', messageIds: ['m1'], reason: 'Job obsolete' }],
    ['no messageIds', { queueLabel: 'quest', messageIds: [], reason: 'Job obsolete' }],
    [
      'too many messageIds',
      { queueLabel: 'quest', messageIds: Array.from({ length: 101 }, (_, i) => `m${i}`), reason: 'Job obsolete' },
    ],
    ['missing messageIds', { queueLabel: 'quest', reason: 'Job obsolete' }],
    [
      'a client-supplied messages payload',
      { queueLabel: 'quest', messageIds: ['m1'], messages: [message], reason: 'Job obsolete' },
    ],
  ])('rejects %s with a 400 before writing or deleting', async (_name, body) => {
    const { req, res } = request(body);
    await expect(h.post!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.logReplay).not.toHaveBeenCalled();
    expect(h.deleteFromQueue).not.toHaveBeenCalled();
  });

  it('retains the body received from SQS, not one supplied by the request', async () => {
    acquireMessages({ ...message, body: '{"from":"sqs"}' });
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1'], reason: 'Job obsolete' });
    await h.post!(req, res);
    expect(h.logReplay).toHaveBeenCalledWith(expect.objectContaining({ messageBody: '{"from":"sqs"}' }));
  });

  it('retains the body and reason before delete, and audits only metadata', async () => {
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1'], reason: 'Job obsolete' });
    await h.post!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData())).toMatchObject({ discarded: 1, failed: 0 });
    expect(h.logReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        operation: 'discard',
        reason: 'Job obsolete',
        messageBody: message.body,
        replayedBy: 'admin-1',
      })
    );
    expect(h.logReplay.mock.invocationCallOrder[0]).toBeLessThan(h.deleteFromQueue.mock.invocationCallOrder[0]);
    expect(h.deleteFromQueue.mock.invocationCallOrder[0]).toBeLessThan(h.finalizeDiscard.mock.invocationCallOrder[0]);
    expect(h.finalizeDiscard).toHaveBeenCalledWith('log-1', 'discarded', undefined);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.dlq.discarded',
      reason: 'Job obsolete',
      details: { queueLabel: 'quest', messageCount: 1, discardedMessageIds: ['m1'] },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('payload');
    expect(h.deleteFromQueue).toHaveBeenCalledWith('dlq-url', 'receipt-1');
  });

  it.each([
    ['quest', 'dlq-url', 'Quest queue'],
    ['exports', 'exports-dlq-url', 'Export queue'],
  ])(
    'retains and deletes each distinct message in the selected %s queue',
    async (queueLabel, queueUrl, displayName) => {
      const messages = [
        { messageId: 'first-message', receiptHandle: 'first-receipt', body: '{"work":"first"}' },
        { messageId: 'second-message', receiptHandle: 'second-receipt', body: '{"work":"second"}' },
      ];
      acquireMessages(...messages);
      h.logReplay.mockResolvedValueOnce({ id: 'first-log' }).mockResolvedValueOnce({ id: 'second-log' });
      const { req, res } = request({ queueLabel, messageIds: messages.map(m => m.messageId), reason: 'Job obsolete' });

      await h.post!(req, res);

      expect(JSON.parse(res._getData())).toMatchObject({ discarded: 2, failed: 0 });
      for (const [index, currentMessage] of messages.entries()) {
        expect(h.logReplay).toHaveBeenNthCalledWith(index + 1, {
          queueLabel,
          messageId: currentMessage.messageId,
          messageBody: currentMessage.body,
          sourceQueue: displayName,
          operation: 'discard',
          status: 'pending',
          reason: 'Job obsolete',
          replayedBy: 'admin-1',
        });
        expect(h.deleteFromQueue).toHaveBeenNthCalledWith(index + 1, queueUrl, currentMessage.receiptHandle);
        expect(h.finalizeDiscard).toHaveBeenNthCalledWith(
          index + 1,
          index === 0 ? 'first-log' : 'second-log',
          'discarded',
          undefined
        );
        expect(h.logReplay.mock.invocationCallOrder[index]).toBeLessThan(
          h.deleteFromQueue.mock.invocationCallOrder[index]
        );
        expect(h.deleteFromQueue.mock.invocationCallOrder[index]).toBeLessThan(
          h.finalizeDiscard.mock.invocationCallOrder[index]
        );
      }
      expect(h.audit.mock.calls[0][1].details.discardedMessageIds).toEqual(messages.map(current => current.messageId));
    }
  );

  it('never deletes when the body cannot be retained', async () => {
    h.logReplay.mockRejectedValue(new Error('database unavailable'));
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1'], reason: 'Bad payload' });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({ discarded: 0, failed: 1 });
    expect(h.deleteFromQueue).not.toHaveBeenCalled();
  });

  it('keeps an acknowledged deletion successful when terminal history cannot be confirmed', async () => {
    h.finalizeDiscard.mockRejectedValue(new Error('database unavailable'));
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1'], reason: 'Bad payload' });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({
      discarded: 1,
      failed: 0,
      results: [{ messageId: 'm1', status: 'discarded', historyPending: true }],
    });
    expect(h.finalizeDiscard).toHaveBeenCalledTimes(1);
    expect(h.finalizeDiscard).toHaveBeenCalledWith('log-1', 'discarded', undefined);
    expect(h.audit.mock.calls[0][1].details).toMatchObject({
      discardedMessageIds: ['m1'],
      historyPendingMessageIds: ['m1'],
    });
  });

  it('reports unconfirmed history when both deletion and failure finalization fail', async () => {
    h.deleteFromQueue.mockRejectedValue(new Error('expired receipt'));
    h.finalizeDiscard.mockRejectedValue(new Error('database unavailable'));
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1'], reason: 'Bad payload' });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({
      discarded: 0,
      failed: 1,
      results: [{ status: 'failed', reason: 'expired receipt', historyPending: true }],
    });
    expect(h.finalizeDiscard).toHaveBeenCalledWith('log-1', 'failed', 'expired receipt');
  });

  it('keeps mixed-batch counters tied to deletion acknowledgements', async () => {
    h.logReplay
      .mockReset()
      .mockResolvedValueOnce({ id: 'first' })
      .mockResolvedValueOnce({ id: 'second' })
      .mockRejectedValueOnce(new Error('cannot retain'));
    h.deleteFromQueue.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('expired receipt'));
    acquireMessages(message, { ...message, messageId: 'm2' }, { ...message, messageId: 'm3' });
    const { req, res } = request({
      queueLabel: 'quest',
      reason: 'Bad payload',
      messageIds: ['m1', 'm2', 'm3'],
    });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({ discarded: 1, failed: 2 });
    expect(h.deleteFromQueue).toHaveBeenCalledTimes(2);
    expect(h.audit.mock.calls[0][1].details).toMatchObject({ messageCount: 1, failed: 2, discardedMessageIds: ['m1'] });
    expect(JSON.stringify(h.audit.mock.calls[0][1].details)).not.toContain('payload');
  });

  it('marks a failed delete as failed and does not audit it as discarded', async () => {
    h.deleteFromQueue.mockRejectedValue(new Error('expired receipt'));
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1'], reason: 'Bad payload' });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({ discarded: 0, failed: 1 });
    expect(h.finalizeDiscard).toHaveBeenCalledWith('log-1', 'failed', 'expired receipt');
    expect(h.audit.mock.calls[0][1].details.discardedMessageIds).toEqual([]);
  });

  it('still reports the failure and audits when marking the failed delete also fails', async () => {
    h.deleteFromQueue.mockRejectedValue(new Error('expired receipt'));
    h.finalizeDiscard.mockRejectedValue(new Error('database unavailable'));
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1'], reason: 'Bad payload' });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({ discarded: 0, failed: 1 });
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it('reports each message on its own when only some deletes fail', async () => {
    h.deleteFromQueue.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('expired receipt'));
    const second = { ...message, messageId: 'm2', receiptHandle: 'receipt-2' };
    acquireMessages(message, second);
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1', 'm2'], reason: 'Bad payload' });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({
      discarded: 1,
      failed: 1,
      results: [
        { messageId: 'm1', status: 'discarded' },
        { messageId: 'm2', status: 'failed' },
      ],
    });
    expect(h.audit.mock.calls[0][1].details.discardedMessageIds).toEqual(['m1']);
  });
});

describe('POST /api/admin/dlq/discard by message ID', () => {
  const received = (id: string) => ({ MessageId: id, ReceiptHandle: `fresh-${id}`, Body: `{"id":"${id}"}` });

  it('receives the requested messages itself and deletes them with fresh receipt handles', async () => {
    h.acquire.mockResolvedValue({ found: [received('m1'), received('m2')], notFound: [] });
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1', 'm2'], reason: 'Job obsolete' });
    await h.post!(req, res);

    expect(h.acquire).toHaveBeenCalledWith('dlq-url', 'quest', ['m1', 'm2'], expect.any(Object));
    expect(h.logReplay).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1', messageBody: '{"id":"m1"}' }));
    expect(h.deleteFromQueue).toHaveBeenCalledWith('dlq-url', 'fresh-m1');
    expect(h.deleteFromQueue).toHaveBeenCalledWith('dlq-url', 'fresh-m2');
    expect(res._getJSONData()).toMatchObject({ discarded: 2, failed: 0, notFound: 0 });
  });

  it('reports IDs it could not find without touching them', async () => {
    h.acquire.mockResolvedValue({ found: [received('m1')], notFound: ['gone'] });
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1', 'gone'], reason: 'Job obsolete' });
    await h.post!(req, res);

    expect(h.deleteFromQueue).toHaveBeenCalledTimes(1);
    expect(res._getJSONData()).toMatchObject({ discarded: 1, notFound: 1 });
    expect(res._getJSONData().results.map((r: { messageId: string }) => r.messageId)).toEqual(['m1']);
    expect(h.audit.mock.calls[0][1].details).toMatchObject({
      discardedMessageIds: ['m1'],
      notFoundMessageIds: ['gone'],
    });
  });

  it('releases a message it acquired but could not retain, and leaves it in the queue', async () => {
    h.acquire.mockResolvedValue({ found: [received('m1')], notFound: [] });
    h.logReplay.mockRejectedValueOnce(new Error('mongo down'));
    h.changeMessageVisibility.mockResolvedValue(undefined);
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1'], reason: 'Job obsolete' });
    await h.post!(req, res);

    expect(h.deleteFromQueue).not.toHaveBeenCalled();
    expect(h.changeMessageVisibility).toHaveBeenCalledWith('dlq-url', 'fresh-m1', 0);
    expect(res._getJSONData()).toMatchObject({ discarded: 0, failed: 1 });
  });

  it('touches nothing when the targeted receive fails', async () => {
    h.acquire.mockRejectedValue(new Error('throttled'));
    const { req, res } = request({ queueLabel: 'quest', messageIds: ['m1'], reason: 'Job obsolete' });
    await expect(h.post!(req, res)).rejects.toThrow('throttled');
    expect(h.logReplay).not.toHaveBeenCalled();
    expect(h.deleteFromQueue).not.toHaveBeenCalled();
  });
});
