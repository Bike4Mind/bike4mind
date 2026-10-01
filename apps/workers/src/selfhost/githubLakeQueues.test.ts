import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';

const { ingestDispatch, revokeDispatch } = vi.hoisted(() => ({ ingestDispatch: vi.fn(), revokeDispatch: vi.fn() }));
vi.mock('@server/queueHandlers/githubLakeIngest', () => ({ dispatch: ingestDispatch }));
vi.mock('@server/queueHandlers/githubLakeRevoke', () => ({ dispatch: revokeDispatch }));
import { registerGitHubLakeQueues } from './githubLakeQueues';

const urls = { ingest: 'http://sqs/github-lake-ingest', revoke: 'http://sqs/github-lake-revoke' };

describe('registerGitHubLakeQueues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ingestDispatch.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('registers both queues one message at a time, with the hosted visibility and receive counts', () => {
    const worker = { registerQueueHandler: vi.fn() };
    registerGitHubLakeQueues(worker, urls);
    expect(worker.registerQueueHandler).toHaveBeenCalledWith(
      'githubLakeIngestQueue',
      urls.ingest,
      expect.any(Function),
      { batchSize: 1, visibilityTimeoutSec: 720, maxReceiveCount: 2 }
    );
    expect(worker.registerQueueHandler).toHaveBeenCalledWith('githubLakeRevokeQueue', urls.revoke, revokeDispatch, {
      batchSize: 1,
      visibilityTimeoutSec: 720,
      maxReceiveCount: 7,
    });
  });

  it('gives each ingest run the hosted 10-minute budget instead of the worker deadline', async () => {
    const worker = { registerQueueHandler: vi.fn() };
    registerGitHubLakeQueues(worker, urls);
    const handler = worker.registerQueueHandler.mock.calls[0][2];
    vi.useFakeTimers();
    const event = { Records: [] } as unknown as SQSEvent;
    const context = { functionName: 'worker', getRemainingTimeInMillis: () => 86_400_000 } as Context;

    await handler(event, context);
    const forwarded = ingestDispatch.mock.calls[0][1];
    expect(forwarded.functionName).toBe('worker');
    expect(forwarded.getRemainingTimeInMillis()).toBe(600_000);
    await vi.advanceTimersByTimeAsync(510_000);
    expect(forwarded.getRemainingTimeInMillis()).toBe(90_000);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(forwarded.getRemainingTimeInMillis()).toBe(0);

    await handler(event, context);
    expect(ingestDispatch.mock.calls[1][1].getRemainingTimeInMillis()).toBe(600_000);
  });

  it('preserves an ingest rejection so the broker redelivers', async () => {
    const worker = { registerQueueHandler: vi.fn() };
    registerGitHubLakeQueues(worker, urls);
    ingestDispatch.mockRejectedValueOnce(new Error('rate limited'));
    await expect(worker.registerQueueHandler.mock.calls[0][2]({ Records: [] }, {})).rejects.toThrow('rate limited');
  });
});
