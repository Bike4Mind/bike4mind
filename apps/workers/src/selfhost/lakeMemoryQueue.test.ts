import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('@workers/queueHandlers/lakeMemoryExtraction', () => ({ dispatch }));
import { registerLakeMemoryQueue } from './lakeMemoryQueue';

const logger = { warn: vi.fn() } as unknown as Logger;

describe('registerLakeMemoryQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatch.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('leaves an unconfigured optional queue unregistered', () => {
    const worker = { registerQueueHandler: vi.fn() };
    registerLakeMemoryQueue(worker, undefined, logger);
    expect(worker.registerQueueHandler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('uses one message and visibility beyond the extraction lease, permitting redelivery', async () => {
    const worker = { registerQueueHandler: vi.fn() };
    registerLakeMemoryQueue(worker, 'http://sqs/lake-memory', logger);
    expect(worker.registerQueueHandler).toHaveBeenCalledWith(
      'lakeMemoryQueue',
      'http://sqs/lake-memory',
      expect.any(Function),
      { batchSize: 1, visibilityTimeoutSec: 1020, maxReceiveCount: 2 }
    );
    const handler = worker.registerQueueHandler.mock.calls[0][2];
    vi.useFakeTimers();
    const event = { Records: [] } as SQSEvent;
    const context = { functionName: 'lake', getRemainingTimeInMillis: () => 86_400_000 } as Context;
    await handler(event, context);
    const forwarded = dispatch.mock.calls[0][1];
    expect(forwarded.functionName).toBe('lake');
    expect(forwarded.getRemainingTimeInMillis()).toBe(600_000);
    await vi.advanceTimersByTimeAsync(530_000);
    expect(forwarded.getRemainingTimeInMillis()).toBe(70_000);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(forwarded.getRemainingTimeInMillis()).toBe(0);
    await handler(event, context);
    expect(dispatch.mock.calls[1][1].getRemainingTimeInMillis()).toBe(600_000);
  });

  it('preserves handler rejection for broker redelivery', async () => {
    const worker = { registerQueueHandler: vi.fn() };
    registerLakeMemoryQueue(worker, 'http://sqs/lake-memory', logger);
    dispatch.mockRejectedValueOnce(new Error('transient lookup'));
    await expect(worker.registerQueueHandler.mock.calls[0][2]({ Records: [] }, {})).rejects.toThrow('transient lookup');
  });
});
