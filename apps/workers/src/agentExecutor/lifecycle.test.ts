import type { Message } from '@aws-sdk/client-sqs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutorLifecycle } from './lifecycle';
import type { QueueMessageDeps } from './queueMessage';
import { runQueueMessage } from './server';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const message = (receipt = 'receipt-one'): Message => ({
  MessageId: 'execution-one',
  ReceiptHandle: receipt,
  Body: JSON.stringify({
    kind: 'continuation',
    executionId: '0123456789abcdef01234567',
    connectionId: 'connection-one',
  }),
  Attributes: { ApproximateReceiveCount: receipt === 'receipt-one' ? '1' : '2' },
});

function harness(concurrency = 2) {
  const polls: ReturnType<typeof deferred<Message[]>>[] = [];
  const receive = vi.fn(() => {
    const poll = deferred<Message[]>();
    polls.push(poll);
    return poll.promise;
  });
  const probe = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const queueMessage: QueueMessageDeps = {
    run: vi.fn<QueueMessageDeps['run']>().mockResolvedValue(undefined),
    deleteMessage: vi.fn<QueueMessageDeps['deleteMessage']>().mockResolvedValue(undefined),
    extendVisibility: vi.fn<QueueMessageDeps['extendVisibility']>().mockResolvedValue(undefined),
    settleDropped: vi.fn<QueueMessageDeps['settleDropped']>().mockResolvedValue(true),
    logger: { warn: vi.fn(), error: vi.fn() },
    visibilitySeconds: 960,
  };
  const closeAdmission = vi.fn();
  const cleanup = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const exit = vi.fn<(code: number) => void>();
  const lifecycle = createExecutorLifecycle({
    receive,
    probe,
    queueMessage,
    concurrency,
    drainTimeoutMs: 810_000,
    closeAdmission,
    cleanup,
    exit,
  });
  return { lifecycle, polls, receive, probe, queueMessage, closeAdmission, cleanup, exit };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('executor lifecycle', () => {
  it('does not receive or admit until the initial broker probe succeeds', async () => {
    const h = harness();
    const initial = deferred<void>();
    h.probe.mockReturnValueOnce(initial.promise);
    const started = h.lifecycle.start();
    expect(h.lifecycle.isReady()).toBe(false);
    expect(h.receive).not.toHaveBeenCalled();
    initial.resolve();
    await started;
    expect(h.lifecycle.isReady()).toBe(true);
    expect(h.receive).toHaveBeenCalledTimes(2);
  });

  it('propagates a failed startup probe without polling or becoming ready', async () => {
    const h = harness();
    h.probe.mockRejectedValueOnce(new Error('broker unavailable'));
    await expect(h.lifecycle.start()).rejects.toThrow('broker unavailable');
    expect(h.lifecycle.isReady()).toBe(false);
    expect(h.receive).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for real message processing before deleting its receipt and receiving again', async () => {
    const h = harness();
    const work = deferred<void>();
    vi.mocked(h.queueMessage.run).mockReturnValueOnce(work.promise);
    await h.lifecycle.start();
    h.polls[0].resolve([message()]);
    await flush();
    expect(h.queueMessage.run).toHaveBeenCalledWith(message());
    expect(h.queueMessage.deleteMessage).not.toHaveBeenCalled();
    expect(h.receive).toHaveBeenCalledTimes(2);
    work.resolve();
    await flush();
    expect(h.queueMessage.deleteMessage).toHaveBeenCalledExactlyOnceWith(message());
    expect(h.receive).toHaveBeenCalledTimes(3);
  });

  it('retains a failed delivery and deletes only its successful redelivery receipt', async () => {
    const h = harness();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ batchItemFailures: [{ itemIdentifier: 'execution-one' }] })
      .mockResolvedValueOnce({ batchItemFailures: [] });
    vi.mocked(h.queueMessage.run).mockImplementation(delivery => runQueueMessage(delivery, handler));
    await h.lifecycle.start();
    h.polls[0].resolve([message()]);
    await flush();
    expect(h.queueMessage.deleteMessage).not.toHaveBeenCalled();
    expect(h.receive).toHaveBeenCalledTimes(3);
    h.polls[2].resolve([message('receipt-two')]);
    await flush();
    expect(h.queueMessage.run).toHaveBeenCalledTimes(2);
    expect(h.queueMessage.deleteMessage).toHaveBeenCalledExactlyOnceWith(message('receipt-two'));
    expect(h.lifecycle.isReady()).toBe(true);
  });

  it('continues polling after a failed delete instead of losing the consumer slot', async () => {
    const h = harness();
    vi.mocked(h.queueMessage.deleteMessage).mockRejectedValueOnce(new Error('delete failed'));
    await h.lifecycle.start();
    h.polls[0].resolve([message()]);
    await flush();
    expect(h.queueMessage.deleteMessage).toHaveBeenCalledWith(message());
    expect(h.receive).toHaveBeenCalledTimes(3);
    expect(h.lifecycle.isReady()).toBe(true);
  });

  it('backs off on receive failure and recovers only on a successful ten-second probe', async () => {
    const h = harness();
    await h.lifecycle.start();
    h.polls[0].reject(new Error('receive failed'));
    await flush();
    expect(h.lifecycle.isReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.receive).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.receive).toHaveBeenCalledTimes(3);
    h.polls[2].resolve([]);
    await flush();
    expect(h.lifecycle.isReady()).toBe(false);
    h.probe.mockRejectedValueOnce(new Error('probe failed'));
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.probe).toHaveBeenCalledTimes(2);
    expect(h.lifecycle.isReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(9999);
    expect(h.lifecycle.isReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.probe).toHaveBeenCalledTimes(3);
    expect(h.lifecycle.isReady()).toBe(true);
  });

  it('bounds active work by consumer slots and drains their real acknowledgements before cleanup', async () => {
    const h = harness();
    const first = deferred<void>();
    const second = deferred<void>();
    vi.mocked(h.queueMessage.run).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await h.lifecycle.start();
    h.polls[0].resolve([message()]);
    h.polls[1].resolve([message('receipt-two')]);
    await flush();
    expect(h.receive).toHaveBeenCalledTimes(2);
    const stopped = h.lifecycle.shutdown();
    expect(h.lifecycle.shutdown()).toBe(stopped);
    expect(h.lifecycle.isReady()).toBe(false);
    expect(h.closeAdmission).toHaveBeenCalledTimes(1);
    first.resolve();
    await flush();
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
    second.resolve();
    await stopped;
    expect(h.queueMessage.deleteMessage).toHaveBeenCalledTimes(2);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
    await vi.advanceTimersByTimeAsync(810_000);
    expect(h.receive).toHaveBeenCalledTimes(2);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves a message from a late poll untouched after admission closes', async () => {
    const h = harness();
    await h.lifecycle.start();
    const stopped = h.lifecycle.shutdown();
    expect(h.cleanup).not.toHaveBeenCalled();
    h.polls[0].resolve([message()]);
    h.polls[1].resolve([]);
    await stopped;
    expect(h.queueMessage.run).not.toHaveBeenCalled();
    expect(h.queueMessage.deleteMessage).not.toHaveBeenCalled();
    expect(h.receive).toHaveBeenCalledTimes(2);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('does not resume polling from backoff or recover readiness from a late probe after stopping', async () => {
    const h = harness();
    const pendingProbe = deferred<void>();
    await h.lifecycle.start();
    h.probe.mockReturnValueOnce(pendingProbe.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    h.polls[0].reject(new Error('receive failed'));
    await flush();
    const stopped = h.lifecycle.shutdown();
    pendingProbe.resolve();
    h.polls[1].resolve([]);
    await vi.advanceTimersByTimeAsync(1000);
    await stopped;
    expect(h.lifecycle.isReady()).toBe(false);
    expect(h.receive).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.probe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['receive', 'processing'] as const)('forces exit at the exact deadline for a hung %s', async phase => {
    const h = harness();
    await h.lifecycle.start();
    if (phase === 'processing') {
      vi.mocked(h.queueMessage.run).mockReturnValue(new Promise(() => {}));
      h.polls[0].resolve([message()]);
      await flush();
    }
    h.lifecycle.shutdown();
    await vi.advanceTimersByTimeAsync(809_999);
    expect(h.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(h.cleanup).not.toHaveBeenCalled();
  });
  it('keeps the deadline armed during cleanup and never exits successfully after it expires', async () => {
    const h = harness();
    const cleanup = deferred<void>();
    h.cleanup.mockReturnValueOnce(cleanup.promise);
    await h.lifecycle.start();
    const stopped = h.lifecycle.shutdown();
    for (const poll of h.polls) poll.resolve([]);
    await flush();
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(809_999);
    expect(h.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
    cleanup.resolve();
    await stopped;
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports cleanup rejection with a failure exit and no unhandled rejection', async () => {
    const h = harness();
    h.cleanup.mockRejectedValueOnce(new Error('disconnect failed'));
    await h.lifecycle.start();
    const stopped = h.lifecycle.shutdown();
    for (const poll of h.polls) poll.resolve([]);
    await expect(stopped).resolves.toBeUndefined();
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(h.queueMessage.logger.error).toHaveBeenCalledWith('Agent executor shutdown failed', {
      error: 'disconnect failed',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for successful cleanup and cancels the deadline afterward', async () => {
    const h = harness();
    const cleanup = deferred<void>();
    h.cleanup.mockReturnValueOnce(cleanup.promise);
    await h.lifecycle.start();
    const stopped = h.lifecycle.shutdown();
    for (const poll of h.polls) poll.resolve([]);
    await vi.advanceTimersByTimeAsync(809_999);
    expect(h.exit).not.toHaveBeenCalled();
    cleanup.resolve();
    await stopped;
    await vi.advanceTimersByTimeAsync(1);
    expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
