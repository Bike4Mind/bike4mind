import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';
const { dispatch, attributes } = vi.hoisted(() => ({ dispatch: vi.fn(), attributes: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ deleteFromQueue: vi.fn() }));
vi.mock('@workers/queueHandlers/accountErasure', () => ({ dispatch }));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = (command: { kind?: string }) => (command.kind === 'attributes' ? attributes(command) : Promise.resolve({}));
  },
  GetQueueAttributesCommand: class {
    kind = 'attributes';
    constructor(public input: { QueueUrl: string }) {}
  },
  ChangeMessageVisibilityCommand: class {
    constructor(public input: unknown) {}
  },
}));
import { registerAccountErasureQueue } from './accountErasureQueue';

const logger = { warn: vi.fn(), error: vi.fn() };
const DLQ_ARN = 'account-erasure-dlq-target';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ACCOUNT_ERASURE_QUEUE_DLQ', 'http://queue/accountErasureQueueDLQ');
  attributes.mockImplementation(async (command: { input: { QueueUrl: string } }) =>
    command.input.QueueUrl.endsWith('DLQ')
      ? { Attributes: { QueueArn: DLQ_ARN } }
      : { Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: DLQ_ARN, maxReceiveCount: 3 }) } }
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it('registers the erasure handler one job at a time behind the verified redrive', async () => {
  const worker = { registerQueueHandler: vi.fn() };
  await registerAccountErasureQueue(worker, 'http://queue/accountErasureQueue', logger);

  expect(worker.registerQueueHandler).toHaveBeenCalledWith(
    'accountErasureQueue',
    'http://queue/accountErasureQueue',
    expect.any(Function),
    expect.objectContaining({ batchSize: 1, visibilityTimeoutSec: 900 })
  );
  const context = { getRemainingTimeInMillis: () => 999999 } as Context;
  await worker.registerQueueHandler.mock.calls[0][2]({ Records: [{ receiptHandle: 'r' }] } as SQSEvent, context);
  expect(dispatch).toHaveBeenCalledOnce();
});

it('stays off when the queue is not configured', async () => {
  const worker = { registerQueueHandler: vi.fn() };
  await registerAccountErasureQueue(worker, undefined, logger);
  expect(worker.registerQueueHandler).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('accountErasureQueue not configured'));
});
