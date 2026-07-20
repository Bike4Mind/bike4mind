import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { Message } from '@aws-sdk/client-sqs';

const { mockReceiveFromQueue, mockDeleteFromQueue } = vi.hoisted(() => ({
  mockReceiveFromQueue: vi.fn(),
  mockDeleteFromQueue: vi.fn(),
}));

vi.mock('@server/utils/sqs', () => ({
  receiveFromQueue: mockReceiveFromQueue,
  deleteFromQueue: mockDeleteFromQueue,
}));

const { SelfHostWorker } = await import('./selfHostWorker');

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const makeMessage = (overrides: Partial<Message> = {}): Message => ({
  MessageId: 'm1',
  ReceiptHandle: 'r1',
  Body: JSON.stringify({ hello: 'world' }),
  Attributes: { ApproximateReceiveCount: '1' },
  ...overrides,
});

/** Return `batch` once, then stop the worker and return [] so the poller loop exits. */
function drainOnce(worker: { stop: () => void }, batch: Message[]) {
  let n = 0;
  mockReceiveFromQueue.mockImplementation(async () => {
    n += 1;
    if (n === 1) return batch;
    worker.stop();
    return [];
  });
}

describe('SelfHostWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteFromQueue.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes a message after the handler succeeds', async () => {
    const worker = new SelfHostWorker(mockLogger);
    const dispatch = vi.fn().mockResolvedValue(undefined);
    drainOnce(worker, [makeMessage()]);
    worker.registerQueueHandler('q', 'http://sqs/q', dispatch);

    worker.start();

    await vi.waitFor(() => expect(mockDeleteFromQueue).toHaveBeenCalledWith('http://sqs/q', 'r1'));
    expect(dispatch).toHaveBeenCalledTimes(1);
    // The synthetic event carries the message body as the single SQS record.
    const [event] = dispatch.mock.calls[0];
    expect(event.Records[0].body).toBe(JSON.stringify({ hello: 'world' }));
    worker.stop();
  });

  it('leaves a failed message for retry below the cap, and drops it as poison above the cap', async () => {
    const worker = new SelfHostWorker(mockLogger);
    const dispatch = vi.fn().mockRejectedValue(new Error('boom'));
    const belowCap = makeMessage({
      MessageId: 'below',
      ReceiptHandle: 'rc-below',
      Attributes: { ApproximateReceiveCount: '1' },
    });
    const overCap = makeMessage({
      MessageId: 'over',
      ReceiptHandle: 'rc-over',
      Attributes: { ApproximateReceiveCount: '4' },
    });
    drainOnce(worker, [belowCap, overCap]);
    worker.registerQueueHandler('q', 'http://sqs/q', dispatch, { maxReceiveCount: 3 });

    worker.start();

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    // Below cap: left for redelivery (not deleted). Over cap: deleted as poison.
    expect(mockDeleteFromQueue).toHaveBeenCalledTimes(1);
    expect(mockDeleteFromQueue).toHaveBeenCalledWith('http://sqs/q', 'rc-over');
    worker.stop();
  });

  it('keeps processing the rest of a batch when one message handler throws', async () => {
    const worker = new SelfHostWorker(mockLogger);
    const bad = makeMessage({ MessageId: 'bad', ReceiptHandle: 'rc-bad', Body: 'bad' });
    const good = makeMessage({ MessageId: 'good', ReceiptHandle: 'rc-good', Body: 'good' });
    const dispatch = vi.fn(async (event: { Records: { body: string }[] }) => {
      if (event.Records[0].body === 'bad') throw new Error('boom');
    });
    drainOnce(worker, [bad, good]);
    worker.registerQueueHandler('q', 'http://sqs/q', dispatch);

    worker.start();

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    // Only the good message is deleted; the bad one is left for retry.
    expect(mockDeleteFromQueue).toHaveBeenCalledTimes(1);
    expect(mockDeleteFromQueue).toHaveBeenCalledWith('http://sqs/q', 'rc-good');
    worker.stop();
  });

  it('fires a scheduled task on its interval', async () => {
    vi.useFakeTimers();
    const worker = new SelfHostWorker(mockLogger);
    const fn = vi.fn().mockResolvedValue(undefined);
    worker.registerScheduledTask('scheduler', 60_000, fn);

    worker.start(); // no queue handlers -> no pollers to interfere with fake timers

    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(2);
    worker.stop();
  });

  it('does not start a scheduled task again while its previous run is still in flight', async () => {
    vi.useFakeTimers();
    const worker = new SelfHostWorker(mockLogger);
    let resolveRun: (() => void) | undefined;
    const fn = vi.fn(() => new Promise<void>(resolve => (resolveRun = resolve)));
    worker.registerScheduledTask('scheduler', 60_000, fn);

    worker.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
    // A second tick fires while the first run is still pending -> skipped, not overlapped.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);

    // Once the first run finishes, a later tick runs the task again.
    resolveRun?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(2);
    worker.stop();
  });
});
