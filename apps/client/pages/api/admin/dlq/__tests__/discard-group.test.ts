// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const MATCH = 'a'.repeat(16);

const h = vi.hoisted(() => ({
  post: undefined as ((req: unknown, res: unknown) => Promise<void>) | undefined,
  routeOptions: undefined as unknown,
  receive: vi.fn(),
  logReplay: vi.fn(),
  finalizeDiscard: vi.fn(),
  deleteFromQueue: vi.fn(),
  changeMessageVisibility: vi.fn(),
  findFailures: vi.fn(),
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
  getDlqByLabel: (label: string) =>
    label === 'cron' ? { label, displayName: 'Spend Monitor', sourceQueue: null } : undefined,
  getDlqUrl: () => 'cron-dlq-url',
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  receiveFromQueue: h.receive,
  deleteFromQueue: h.deleteFromQueue,
  changeMessageVisibility: h.changeMessageVisibility,
}));
vi.mock('@bike4mind/server-utils/utils/dlqMessages', () => ({
  DLQ_BROWSE_MESSAGE_ATTRIBUTES: ['All'],
  findDlqFailures: h.findFailures,
}));
// The real signature is covered in server-utils; here a body of "boom" fails one way and anything else another.
vi.mock('@bike4mind/server-utils/utils/dlqMessageRow', () => ({
  DLQ_SIGNATURE_UNAVAILABLE: 'unavailable',
  rowFailure: (message: { Body?: string }, recorded?: { errorMessage: string }) =>
    recorded ? { errorMessage: recorded.errorMessage } : message.Body ? { errorMessage: message.Body } : undefined,
  dlqFailureSignature: (failure?: { errorMessage: string }) =>
    !failure ? 'none' : failure.errorMessage === 'boom' ? 'a'.repeat(16) : 'b'.repeat(16),
}));
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
vi.mock('@bike4mind/observability', () => ({ Logger: { error: vi.fn(), warn: vi.fn() } }));

import '../discard-group';

const sqsMessage = (id: string, body: string) => ({ MessageId: id, ReceiptHandle: `receipt-${id}`, Body: body });

const invoke = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await h.post!(req, res);
  return res._getJSONData();
};

const queueBatches = (...batches: ReturnType<typeof sqsMessage>[][]) => {
  for (const batch of batches) h.receive.mockResolvedValueOnce(batch);
  h.receive.mockResolvedValue([]);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.receive.mockReset();
  h.logReplay.mockImplementation(async ({ messageId }: { messageId: string }) => ({ id: `log-${messageId}` }));
  h.deleteFromQueue.mockResolvedValue(undefined);
  h.finalizeDiscard.mockResolvedValue(undefined);
  h.changeMessageVisibility.mockResolvedValue(undefined);
  h.findFailures.mockResolvedValue({ failures: [], lookupFailed: false });
});

describe('POST /api/admin/dlq/discard-group', () => {
  it('is a JWT-only settings:manage write', () => {
    expect(h.routeOptions).toMatchObject({ auth: 'jwtOnly', adminPermissions: { POST: 'settings:manage' } });
  });

  it('discards only matching messages, history first, and releases the rest when the queue runs out', async () => {
    queueBatches([sqsMessage('m1', 'boom'), sqsMessage('o1', 'other')], [sqsMessage('m2', 'boom')]);
    const result = await invoke({ queueLabel: 'cron', failureSignature: MATCH, reason: 'Job obsolete' });

    expect(result).toMatchObject({ discarded: 2, failed: 0, examined: 3, stoppedBy: 'exhausted', complete: true });
    expect(h.deleteFromQueue.mock.calls).toEqual([
      ['cron-dlq-url', 'receipt-m1'],
      ['cron-dlq-url', 'receipt-m2'],
    ]);
    expect(h.logReplay.mock.invocationCallOrder[0]).toBeLessThan(h.deleteFromQueue.mock.invocationCallOrder[0]);
    expect(h.logReplay).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm1', operation: 'discard', status: 'pending', reason: 'Job obsolete' })
    );
    expect(h.changeMessageVisibility.mock.calls).toEqual([['cron-dlq-url', 'receipt-o1', 0]]);
    // Examined messages stay hidden during the run so each receive surfaces new ones.
    expect(h.receive).toHaveBeenCalledWith('cron-dlq-url', 10, 60, 1, ['All']);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.dlq.discarded',
      details: { queueLabel: 'cron', failureSignature: MATCH, messageCount: 2, discardedMessageIds: ['m1', 'm2'] },
    });
  });

  it('matches on the recorded failure, not the body, when one exists', async () => {
    queueBatches([sqsMessage('m1', 'boom')]);
    h.findFailures.mockResolvedValue({
      failures: [{ messageId: 'm1', errorMessage: 'recorded' }],
      lookupFailed: false,
    });
    const result = await invoke({ queueLabel: 'cron', failureSignature: MATCH, reason: 'Job obsolete' });
    expect(result.discarded).toBe(0);
    expect(h.deleteFromQueue).not.toHaveBeenCalled();
    expect(h.changeMessageVisibility).toHaveBeenCalledWith('cron-dlq-url', 'receipt-m1', 0);
  });

  it('stops at the limit and leaves further matches in the queue', async () => {
    queueBatches([sqsMessage('m1', 'boom'), sqsMessage('m2', 'boom'), sqsMessage('m3', 'boom')]);
    const result = await invoke({ queueLabel: 'cron', failureSignature: MATCH, reason: 'Job obsolete', limit: 2 });
    expect(result).toMatchObject({ discarded: 2, stoppedBy: 'limit', complete: false });
    expect(h.changeMessageVisibility).toHaveBeenCalledWith('cron-dlq-url', 'receipt-m3', 0);
  });

  it('discards nothing and releases the batch when recorded failures cannot be looked up', async () => {
    queueBatches([sqsMessage('m1', 'boom')]);
    h.findFailures.mockResolvedValue({ failures: [], lookupFailed: true });
    const result = await invoke({ queueLabel: 'cron', failureSignature: MATCH, reason: 'Job obsolete' });
    expect(result).toMatchObject({ discarded: 0, stoppedBy: 'lookup_failed', complete: false });
    expect(h.logReplay).not.toHaveBeenCalled();
    expect(h.changeMessageVisibility).toHaveBeenCalledWith('cron-dlq-url', 'receipt-m1', 0);
  });

  it('never deletes a message whose history row could not be written', async () => {
    queueBatches([sqsMessage('m1', 'boom')]);
    h.logReplay.mockRejectedValue(new Error('mongo down'));
    const result = await invoke({ queueLabel: 'cron', failureSignature: MATCH, reason: 'Job obsolete' });
    expect(result).toMatchObject({ discarded: 0, failed: 1 });
    expect(h.deleteFromQueue).not.toHaveBeenCalled();
    expect(h.changeMessageVisibility).toHaveBeenCalledWith('cron-dlq-url', 'receipt-m1', 0);
  });

  it('releases what it holds when a receive fails', async () => {
    h.receive.mockResolvedValueOnce([sqsMessage('o1', 'other')]).mockRejectedValueOnce(new Error('throttled'));
    await expect(
      invoke({ queueLabel: 'cron', failureSignature: 'c'.repeat(16), reason: 'Job obsolete' })
    ).rejects.toThrow('throttled');
    expect(h.changeMessageVisibility).toHaveBeenCalledWith('cron-dlq-url', 'receipt-o1', 0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('still audits what earlier rounds discarded when a later receive fails', async () => {
    h.receive.mockResolvedValueOnce([sqsMessage('m1', 'boom')]).mockRejectedValueOnce(new Error('throttled'));
    await expect(invoke({ queueLabel: 'cron', failureSignature: MATCH, reason: 'Job obsolete' })).rejects.toThrow(
      'throttled'
    );
    expect(h.deleteFromQueue).toHaveBeenCalledWith('cron-dlq-url', 'receipt-m1');
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.dlq.discarded',
      details: { messageCount: 1, discardedMessageIds: ['m1'], stoppedBy: 'error', error: 'throttled' },
    });
  });

  it.each([
    ['an unavailable signature', { failureSignature: 'unavailable' }, /must come from a dead-letter listing/],
    ['a free-form signature', { failureSignature: 'boom' }, /must come from a dead-letter listing/],
    ['an unknown queue', { queueLabel: 'nope' }, /Unknown DLQ/],
    ['a missing reason', { reason: undefined }, /Reason required/],
  ])('refuses %s before receiving', async (_case, override, error) => {
    await expect(
      invoke({ queueLabel: 'cron', failureSignature: MATCH, reason: 'Job obsolete', ...override })
    ).rejects.toThrow(error);
    expect(h.receive).not.toHaveBeenCalled();
  });
});
