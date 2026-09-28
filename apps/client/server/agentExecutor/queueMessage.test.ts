import type { Message } from '@aws-sdk/client-sqs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executionTarget, handleQueueMessage, MAX_RECEIVE_COUNT, type QueueMessageDeps } from './queueMessage';
import { VISIBILITY_SECONDS } from './server';

const executionId = '0123456789abcdef01234567';
const continuation = JSON.stringify({ kind: 'continuation', executionId, connectionId: 'c1' });
const continuationStatuses = ['continuing', 'awaiting_subagent', 'awaiting_dag_children'];

function delivery(receiveCount: number, body = continuation): Message {
  return {
    MessageId: 'm1',
    ReceiptHandle: `receipt-${receiveCount}`,
    Body: body,
    Attributes: { ApproximateReceiveCount: String(receiveCount) },
  };
}

function deps(run: QueueMessageDeps['run']) {
  return {
    run: vi.fn(run),
    deleteMessage: vi.fn<QueueMessageDeps['deleteMessage']>().mockResolvedValue(undefined),
    extendVisibility: vi.fn<QueueMessageDeps['extendVisibility']>().mockResolvedValue(undefined),
    settleDropped: vi.fn<QueueMessageDeps['settleDropped']>().mockResolvedValue(true),
    logger: { warn: vi.fn(), error: vi.fn() },
    visibilitySeconds: VISIBILITY_SECONDS,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('handleQueueMessage', () => {
  it('deletes a message that fails on every delivery once it passes the cap, with one error log', async () => {
    const d = deps(async () => {
      throw new Error('boom');
    });
    for (let count = 1; count <= MAX_RECEIVE_COUNT + 1; count++) await handleQueueMessage(delivery(count), d);
    expect(d.run).toHaveBeenCalledTimes(MAX_RECEIVE_COUNT);
    expect(d.deleteMessage).toHaveBeenCalledTimes(1);
    expect(d.deleteMessage.mock.calls[0][0].ReceiptHandle).toBe(`receipt-${MAX_RECEIVE_COUNT + 1}`);
    expect(d.settleDropped).toHaveBeenCalledWith({ executionId, claimableFrom: continuationStatuses });
    expect(d.logger.error).toHaveBeenCalledTimes(1);
    expect(d.logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        messageId: 'm1',
        executionId,
        receiveCount: MAX_RECEIVE_COUNT + 1,
        executionSettled: true,
      })
    );
    expect(d.logger.warn).toHaveBeenCalledTimes(MAX_RECEIVE_COUNT);
  });
  it('retries a transient failure and processes the message on the next delivery', async () => {
    const d = deps(async () => {
      if (d.run.mock.calls.length === 1) throw new Error('transient');
    });
    await handleQueueMessage(delivery(1), d);
    expect(d.deleteMessage).not.toHaveBeenCalled();
    await handleQueueMessage(delivery(2), d);
    expect(d.run).toHaveBeenCalledTimes(2);
    expect(d.deleteMessage).toHaveBeenCalledTimes(1);
    expect(d.deleteMessage.mock.calls[0][0].ReceiptHandle).toBe('receipt-2');
    expect(d.settleDropped).not.toHaveBeenCalled();
    expect(d.logger.error).not.toHaveBeenCalled();
  });
  it('keeps a run on its last allowed delivery invisible past the visibility timeout, so it is never redelivered', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const d = deps(() => new Promise<void>(resolve => (finish = resolve)));
    let visibleAt = Date.now() + VISIBILITY_SECONDS * 1000;
    d.extendVisibility.mockImplementation(async (_message, seconds) => {
      visibleAt = Date.now() + seconds * 1000;
    });
    const handled = handleQueueMessage(delivery(MAX_RECEIVE_COUNT), d);
    for (let minute = 0; minute < (3 * VISIBILITY_SECONDS) / 60; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(Date.now()).toBeLessThan(visibleAt);
    }
    finish();
    await handled;
    const extensions = d.extendVisibility.mock.calls.length;
    expect(extensions).toBeGreaterThan(0);
    expect(d.extendVisibility.mock.calls.every(([, seconds]) => seconds === VISIBILITY_SECONDS)).toBe(true);
    await vi.advanceTimersByTimeAsync(VISIBILITY_SECONDS * 1000);
    expect(d.extendVisibility).toHaveBeenCalledTimes(extensions);
    expect(d.deleteMessage).toHaveBeenCalledTimes(1);
    expect(d.logger.error).not.toHaveBeenCalled();
  });
  it('still deletes a dropped message when settling its execution fails', async () => {
    const d = deps(async () => {});
    d.settleDropped.mockRejectedValue(new Error('mongo down'));
    await handleQueueMessage(delivery(MAX_RECEIVE_COUNT + 1), d);
    expect(d.run).not.toHaveBeenCalled();
    expect(d.deleteMessage).toHaveBeenCalledTimes(1);
    expect(d.logger.error).toHaveBeenCalledTimes(1);
    expect(d.logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ executionSettled: false, settleError: 'mongo down' })
    );
  });
  it('drops an unparseable message without attempting to settle an execution', async () => {
    const d = deps(async () => {});
    await handleQueueMessage(delivery(MAX_RECEIVE_COUNT + 1, 'not json'), d);
    expect(d.settleDropped).not.toHaveBeenCalled();
    expect(d.deleteMessage).toHaveBeenCalledTimes(1);
    expect(d.logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ executionId: undefined })
    );
  });
});

describe('executionTarget', () => {
  it.each([
    ['a start invocation', { kind: 'selfhost_invoke', payload: { executionId, query: 'hi' } }, ['pending']],
    ['a direct continuation invocation', { kind: 'selfhost_invoke', payload: { executionId } }, continuationStatuses],
    ['a tagged continuation', { kind: 'continuation', executionId }, continuationStatuses],
    ['a legacy untagged continuation', { executionId }, continuationStatuses],
  ])('maps %s to the statuses its claim moves out of', (_name, body, claimableFrom) => {
    expect(executionTarget(JSON.stringify(body))).toEqual({ executionId, claimableFrom });
  });
  it.each(['subagent_dispatch', 'dag_node_dispatch'])('maps a %s to its pending child', kind => {
    expect(executionTarget(JSON.stringify({ kind, childExecutionId: executionId }))).toEqual({
      executionId,
      claimableFrom: ['pending'],
    });
  });
  it.each([
    ['malformed JSON', 'not json'],
    ['an unknown kind', JSON.stringify({ kind: 'mystery', executionId })],
    ['a non-ObjectId id', JSON.stringify({ kind: 'continuation', executionId: 'e1' })],
    ['a missing body', undefined],
  ])('returns nothing for %s', (_name, body) => {
    expect(executionTarget(body)).toBeUndefined();
  });
});
