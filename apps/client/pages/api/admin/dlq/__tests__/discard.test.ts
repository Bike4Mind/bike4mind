// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  post: undefined as ((req: unknown, res: unknown) => Promise<void>) | undefined,
  logReplay: vi.fn(),
  markDiscardFailed: vi.fn(),
  deleteFromQueue: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => ({
    post: (fn: typeof h.post) => {
      h.post = fn;
    },
  }),
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqByLabel: (label: string) => (label === 'quest' ? { label, displayName: 'Quest queue' } : undefined),
  getDlqUrl: () => 'dlq-url',
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ deleteFromQueue: h.deleteFromQueue }));
vi.mock('@bike4mind/database', () => ({
  dlqReplayLogRepository: { logReplay: h.logReplay, markDiscardFailed: h.markDiscardFailed },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  parseAdminActionReason: (value: unknown) => {
    if (typeof value !== 'string' || value.trim().length < 5) throw new Error('Reason required');
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
  h.markDiscardFailed.mockResolvedValue(undefined);
});

describe('POST /api/admin/dlq/discard', () => {
  it('rejects a missing reason before writing or deleting', async () => {
    const { req, res } = request({ queueLabel: 'quest', messages: [message] });
    await expect(h.post!(req, res)).rejects.toThrow('Reason required');
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
        status: 'discarded',
        reason: 'Job obsolete',
        messageBody: message.body,
        replayedBy: 'admin-1',
      })
    );
    expect(h.logReplay.mock.invocationCallOrder[0]).toBeLessThan(h.deleteFromQueue.mock.invocationCallOrder[0]);
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

  it('marks a failed delete as failed and does not audit it as discarded', async () => {
    h.deleteFromQueue.mockRejectedValue(new Error('expired receipt'));
    const { req, res } = request({ queueLabel: 'quest', messages: [message], reason: 'Bad payload' });
    await h.post!(req, res);
    expect(JSON.parse(res._getData())).toMatchObject({ discarded: 0, failed: 1 });
    expect(h.markDiscardFailed).toHaveBeenCalledWith('log-1', 'expired receipt');
    expect(h.audit.mock.calls[0][1].details.discardedMessageIds).toEqual([]);
  });
});
