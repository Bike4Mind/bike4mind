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
  audit: vi.fn(),
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
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqByLabel: (label: string) => (label === 'quest' ? { label, displayName: 'Quest queue' } : undefined),
  getDlqUrl: () => 'dlq-url',
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ deleteFromQueue: h.deleteFromQueue }));
vi.mock('@bike4mind/database', () => ({
  dlqReplayLogRepository: { logReplay: h.logReplay, finalizeDiscard: h.finalizeDiscard },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  parseAdminActionReason: (value: unknown) => {
    if (typeof value !== 'string' || value.trim().length < 5) throw new BadRequestError('Reason required');
    return value.trim();
  },
  recordAdminActionFromRequest: h.audit,
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { error: vi.fn() } }));

import '../discard';

const request = (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  return { req, res };
};
const message = { messageId: 'm1', receiptHandle: 'receipt-1', body: '{"secret":"payload"}' };

beforeEach(() => {
  vi.clearAllMocks();
  h.logReplay.mockResolvedValue({ id: 'log-1' });
  h.deleteFromQueue.mockResolvedValue(undefined);
  h.finalizeDiscard.mockResolvedValue(undefined);
});

describe('POST /api/admin/dlq/discard', () => {
  it('requires a JWT and replay-equivalent permission', () => {
    expect(h.routeOptions).toMatchObject({ auth: 'jwtOnly', adminPermissions: { POST: 'settings:manage' } });
  });

  it('rejects a missing reason before writing or deleting', async () => {
    const { req, res } = request({ queueLabel: 'quest', messages: [message] });
    await expect(h.post!(req, res)).rejects.toThrow('Reason required');
    expect(h.logReplay).not.toHaveBeenCalled();
    expect(h.deleteFromQueue).not.toHaveBeenCalled();
  });

  it.each([
    ['whitespace-only reason', { queueLabel: 'quest', messages: [message], reason: '     ' }],
    ['unknown queue', { queueLabel: 'nope', messages: [message], reason: 'Job obsolete' }],
    ['no messages', { queueLabel: 'quest', messages: [], reason: 'Job obsolete' }],
    ['too many messages', { queueLabel: 'quest', messages: Array(101).fill(message), reason: 'Job obsolete' }],
    ['empty body', { queueLabel: 'quest', messages: [{ ...message, body: '' }], reason: 'Job obsolete' }],
    [
      'empty receipt handle',
      { queueLabel: 'quest', messages: [{ ...message, receiptHandle: '' }], reason: 'Job obsolete' },
    ],
  ])('rejects %s with a 400 before writing or deleting', async (_name, body) => {
    const { req, res } = request(body);
    await expect(h.post!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(h.logReplay).not.toHaveBeenCalled();
    expect(h.deleteFromQueue).not.toHaveBeenCalled();
  });

  it('retains the body and reason before delete, and audits only metadata', async () => {
    const { req, res } = request({ queueLabel: 'quest', messages: [message], reason: 'Job obsolete' });
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

  it('never deletes when the body cannot be retained', async () => {
    h.logReplay.mockRejectedValue(new Error('database unavailable'));
    const { req, res } = request({ queueLabel: 'quest', messages: [message], reason: 'Bad payload' });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({ discarded: 0, failed: 1 });
    expect(h.deleteFromQueue).not.toHaveBeenCalled();
  });

  it('keeps an acknowledged deletion successful when terminal history cannot be confirmed', async () => {
    h.finalizeDiscard.mockRejectedValue(new Error('database unavailable'));
    const { req, res } = request({ queueLabel: 'quest', messages: [message], reason: 'Bad payload' });
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
    const { req, res } = request({ queueLabel: 'quest', messages: [message], reason: 'Bad payload' });
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
    const { req, res } = request({
      queueLabel: 'quest',
      reason: 'Bad payload',
      messages: [message, { ...message, messageId: 'm2' }, { ...message, messageId: 'm3' }],
    });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({ discarded: 1, failed: 2 });
    expect(h.deleteFromQueue).toHaveBeenCalledTimes(2);
    expect(h.audit.mock.calls[0][1].details).toMatchObject({ messageCount: 1, failed: 2, discardedMessageIds: ['m1'] });
    expect(JSON.stringify(h.audit.mock.calls[0][1].details)).not.toContain('payload');
  });

  it('marks a failed delete as failed and does not audit it as discarded', async () => {
    h.deleteFromQueue.mockRejectedValue(new Error('expired receipt'));
    const { req, res } = request({ queueLabel: 'quest', messages: [message], reason: 'Bad payload' });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({ discarded: 0, failed: 1 });
    expect(h.finalizeDiscard).toHaveBeenCalledWith('log-1', 'failed', 'expired receipt');
    expect(h.audit.mock.calls[0][1].details.discardedMessageIds).toEqual([]);
  });

  it('still reports the failure and audits when marking the failed delete also fails', async () => {
    h.deleteFromQueue.mockRejectedValue(new Error('expired receipt'));
    h.finalizeDiscard.mockRejectedValue(new Error('database unavailable'));
    const { req, res } = request({ queueLabel: 'quest', messages: [message], reason: 'Bad payload' });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({ discarded: 0, failed: 1 });
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it('reports each message on its own when only some deletes fail', async () => {
    h.deleteFromQueue.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('expired receipt'));
    const second = { ...message, messageId: 'm2', receiptHandle: 'receipt-2' };
    const { req, res } = request({ queueLabel: 'quest', messages: [message, second], reason: 'Bad payload' });
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
