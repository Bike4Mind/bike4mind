import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';
const { dispatch, renew } = vi.hoisted(() => ({ dispatch: vi.fn(), renew: vi.fn() }));
vi.mock('@server/queueHandlers/notebookCuration', () => ({ dispatch }));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = renew;
  },
  ChangeMessageVisibilityCommand: class {
    constructor(public input: unknown) {}
  },
}));
import { registerNotebookCurationQueue } from './notebookCurationQueue';
const logger = { warn: vi.fn() };
const event = { Records: [{ receiptHandle: 'receipt' }] } as SQSEvent;
const context = { getRemainingTimeInMillis: () => 999999 } as Context;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  renew.mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());
it('receives one job, leaves redrive to the broker, and supplies a decreasing budget', async () => {
  const worker = { registerQueueHandler: vi.fn() };
  registerNotebookCurationQueue(worker, 'http://queue/notebook', logger);
  expect(worker.registerQueueHandler).toHaveBeenCalledWith(
    'notebookCurationQueue',
    'http://queue/notebook',
    expect.any(Function),
    {
      batchSize: 1,
      visibilityTimeoutSec: 900,
      maxReceiveCount: Number.MAX_SAFE_INTEGER,
    }
  );
  await worker.registerQueueHandler.mock.calls[0][2](event, context);
  const forwarded = dispatch.mock.calls[0][1];
  expect(forwarded.getRemainingTimeInMillis()).toBe(600000);
  await vi.advanceTimersByTimeAsync(600001);
  expect(forwarded.getRemainingTimeInMillis()).toBe(0);
  expect(renew).not.toHaveBeenCalled();
});
it('renews in-flight visibility and does not acknowledge renewal failure', async () => {
  const worker = { registerQueueHandler: vi.fn() };
  registerNotebookCurationQueue(worker, 'http://queue/notebook', logger);
  let finish!: () => void;
  dispatch.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  renew.mockRejectedValueOnce(new Error('renew failed'));
  const running = worker.registerQueueHandler.mock.calls[0][2](event, context);
  const result = expect(running).rejects.toThrow('renew failed');
  await vi.advanceTimersByTimeAsync(60000);
  expect(renew).toHaveBeenCalledWith(
    expect.objectContaining({
      input: {
        QueueUrl: 'http://queue/notebook',
        ReceiptHandle: 'receipt',
        VisibilityTimeout: 900,
      },
    })
  );
  finish();
  await result;
  await vi.advanceTimersByTimeAsync(120000);
  expect(renew).toHaveBeenCalledOnce();
});
it('preserves dispatch failure for retry', async () => {
  const worker = { registerQueueHandler: vi.fn() };
  registerNotebookCurationQueue(worker, 'http://queue/notebook', logger);
  dispatch.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(worker.registerQueueHandler.mock.calls[0][2](event, context)).rejects.toThrow('storage unavailable');
  expect(vi.getTimerCount()).toBe(0);
});
