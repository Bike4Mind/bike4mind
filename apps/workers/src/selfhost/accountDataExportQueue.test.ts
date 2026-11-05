import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';
const { dispatch, attributes } = vi.hoisted(() => ({ dispatch: vi.fn(), attributes: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ deleteFromQueue: vi.fn() }));
vi.mock('@workers/queueHandlers/accountDataExport', () => ({ dispatch }));
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
import { registerAccountDataExportQueue } from './accountDataExportQueue';

const logger = { warn: vi.fn(), error: vi.fn() };
const DLQ_ARN = 'account-data-export-dlq-target';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ACCOUNT_DATA_EXPORT_QUEUE_DLQ', 'http://queue/accountDataExportQueueDLQ');
  attributes.mockImplementation(async (command: { input: { QueueUrl: string } }) =>
    command.input.QueueUrl.endsWith('DLQ')
      ? { Attributes: { QueueArn: DLQ_ARN } }
      : { Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: DLQ_ARN, maxReceiveCount: 3 }) } }
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it('registers the export handler one job at a time behind the verified redrive', async () => {
  const worker = { registerQueueHandler: vi.fn() };
  await registerAccountDataExportQueue(worker, 'http://queue/accountDataExportQueue', logger);

  expect(worker.registerQueueHandler).toHaveBeenCalledWith(
    'accountDataExportQueue',
    'http://queue/accountDataExportQueue',
    expect.any(Function),
    expect.objectContaining({ batchSize: 1, visibilityTimeoutSec: 900 })
  );
  const context = { getRemainingTimeInMillis: () => 999999 } as Context;
  await worker.registerQueueHandler.mock.calls[0][2]({ Records: [{ receiptHandle: 'r' }] } as SQSEvent, context);
  expect(dispatch).toHaveBeenCalledOnce();
});

it('stays off when the queue is not configured', async () => {
  const worker = { registerQueueHandler: vi.fn() };
  await registerAccountDataExportQueue(worker, undefined, logger);
  expect(worker.registerQueueHandler).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('accountDataExportQueue not configured'));
});
