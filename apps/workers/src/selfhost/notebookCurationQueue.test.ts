import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';
const { dispatch, renew, attributes, deleteMessage } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  renew: vi.fn(),
  attributes: vi.fn(),
  deleteMessage: vi.fn(),
}));
vi.mock('@server/utils/sqs', () => ({ deleteFromQueue: deleteMessage }));
vi.mock('@server/queueHandlers/notebookCuration', () => ({ dispatch }));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = (command: { kind?: string }) => (command.kind === 'attributes' ? attributes(command) : renew(command));
  },
  GetQueueAttributesCommand: class {
    kind = 'attributes';
    constructor(public input: { QueueUrl: string }) {}
  },
  ChangeMessageVisibilityCommand: class {
    constructor(public input: unknown) {}
  },
}));
import { registerNotebookCurationQueue } from './notebookCurationQueue';
import { SelfHostWorker } from './selfHostWorker';
const logger = { warn: vi.fn() };
const event = { Records: [{ receiptHandle: 'receipt' }] } as SQSEvent;
const context = { getRemainingTimeInMillis: () => 999999 } as Context;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  renew.mockResolvedValue({});
  vi.stubEnv('NOTEBOOK_CURATION_QUEUE_DLQ', 'http://queue/notebookDLQ');
  attributes.mockImplementation(async (command: { input: { QueueUrl: string } }) =>
    command.input.QueueUrl.endsWith('DLQ')
      ? { Attributes: { QueueArn: 'arn:aws:sqs:local:000000000000:notebookDLQ' } }
      : {
          Attributes: {
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: 'arn:aws:sqs:local:000000000000:notebookDLQ',
              maxReceiveCount: 3,
            }),
          },
        }
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it('receives one job, leaves redrive to the broker, and supplies a decreasing budget', async () => {
  const worker = { registerQueueHandler: vi.fn() };
  await registerNotebookCurationQueue(worker, 'http://queue/notebook', logger);
  expect(worker.registerQueueHandler).toHaveBeenCalledWith(
    'notebookCurationQueue',
    'http://queue/notebook',
    expect.any(Function),
    {
      batchSize: 1,
      runBudgetMs: 600000,
      visibilityTimeoutSec: 900,
      maxReceiveCount: Number.MAX_SAFE_INTEGER,
    }
  );
  await worker.registerQueueHandler.mock.calls[0][2](event, context);
  const forwarded = dispatch.mock.calls[0][1];
  expect(forwarded).toBe(context);
  expect(renew).not.toHaveBeenCalled();
});
it('renews in-flight visibility and does not acknowledge renewal failure', async () => {
  const worker = { registerQueueHandler: vi.fn() };
  await registerNotebookCurationQueue(worker, 'http://queue/notebook', logger);
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
  await registerNotebookCurationQueue(worker, 'http://queue/notebook', logger);
  dispatch.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(worker.registerQueueHandler.mock.calls[0][2](event, context)).rejects.toThrow('storage unavailable');
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  undefined,
  '{}',
  '{bad',
  JSON.stringify({ deadLetterTargetArn: 'wrong', maxReceiveCount: 3 }),
  JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:local:000000000000:notebookDLQ', maxReceiveCount: 4 }),
])('refuses registration for invalid redrive policy %s', async policy => {
  const worker = { registerQueueHandler: vi.fn() };
  attributes.mockResolvedValueOnce({ Attributes: { RedrivePolicy: policy } });
  await expect(registerNotebookCurationQueue(worker, 'http://queue/notebook', logger)).rejects.toThrow('redrive');
  expect(worker.registerQueueHandler).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});
it('refuses registration when the configured DLQ cannot be verified', async () => {
  const worker = { registerQueueHandler: vi.fn() };
  attributes.mockRejectedValueOnce(new Error('DLQ unavailable'));
  await expect(registerNotebookCurationQueue(worker, 'http://queue/notebook', logger)).rejects.toThrow();
  expect(worker.registerQueueHandler).not.toHaveBeenCalled();
});
it('allows the third delivery but preserves overflow without running curation', async () => {
  const worker = { registerQueueHandler: vi.fn() };
  await registerNotebookCurationQueue(worker, 'http://queue/notebook', logger);
  const run = worker.registerQueueHandler.mock.calls[0][2];
  await run({ Records: [{ receiptHandle: 'receipt', attributes: { ApproximateReceiveCount: '3' } }] }, context);
  expect(dispatch).toHaveBeenCalledOnce();
  await expect(
    run({ Records: [{ receiptHandle: 'receipt', attributes: { ApproximateReceiveCount: '4' } }] }, context)
  ).rejects.toThrow('redrive');
  expect(dispatch).toHaveBeenCalledOnce();
  expect(renew).not.toHaveBeenCalled();
});

it('does not acknowledge an overflow message through the actual worker', async () => {
  const worker = new SelfHostWorker(logger as unknown as ConstructorParameters<typeof SelfHostWorker>[0]);
  await registerNotebookCurationQueue(worker, 'http://queue/notebook', logger);
  const control = worker as unknown as {
    queues: unknown[];
    handleMessage: (queue: unknown, message: unknown) => Promise<void>;
  };
  await control.handleMessage(control.queues[0], {
    MessageId: 'id',
    ReceiptHandle: 'receipt',
    Body: '{}',
    Attributes: { ApproximateReceiveCount: '4' },
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(deleteMessage).not.toHaveBeenCalled();
  await control.handleMessage(control.queues[0], {
    MessageId: 'id',
    ReceiptHandle: 'receipt',
    Body: '{}',
    Attributes: { ApproximateReceiveCount: '3' },
  });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(deleteMessage).toHaveBeenCalledOnce();
  const context = dispatch.mock.calls[0][1];
  expect(context.getRemainingTimeInMillis()).toBe(600000);
  await vi.advanceTimersByTimeAsync(15000);
  expect(context.getRemainingTimeInMillis()).toBe(585000);
});
