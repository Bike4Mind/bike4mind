import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { markFailedWithRetry, MARK_FAILED_MIN_REMAINING_MS } from './agentExecutor.failureCleanup';

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn() });
const fastRetry = { initialDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 };
const named = (name: string, message = name) => Object.assign(new Error(message), { name });
const networkError = () => named('MongoNetworkError');

describe('markFailedWithRetry', () => {
  it('calls markFailed once when it succeeds first time', async () => {
    const markFailed = vi.fn().mockResolvedValue(undefined);

    await markFailedWithRetry(markFailed, makeLogger(), { retry: fastRetry });

    expect(markFailed).toHaveBeenCalledTimes(1);
  });

  it('recovers when markFailed hits a socket-level error during a brief outage', async () => {
    const markFailed = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(named('MongoPoolClearedError'))
      .mockResolvedValue(undefined);

    await expect(markFailedWithRetry(markFailed, makeLogger(), { retry: fastRetry })).resolves.toBeUndefined();

    expect(markFailed).toHaveBeenCalledTimes(3);
  });

  it('rethrows the last error once retries are spent so the caller can fall back to the sweep', async () => {
    const markFailed = vi.fn().mockRejectedValue(networkError());

    await expect(
      markFailedWithRetry(markFailed, makeLogger(), { retry: { ...fastRetry, maxRetries: 2 } })
    ).rejects.toThrow('MongoNetworkError');

    expect(markFailed).toHaveBeenCalledTimes(3);
  });

  it('does not retry a server-selection timeout, which already waited its full timeout', async () => {
    const markFailed = vi.fn().mockRejectedValue(named('MongoServerSelectionError'));

    await expect(markFailedWithRetry(markFailed, makeLogger(), { retry: fastRetry })).rejects.toThrow();

    expect(markFailed).toHaveBeenCalledTimes(1);
  });

  it.each(['CastError', 'ValidationError'])('does not retry a deterministic %s', async name => {
    const markFailed = vi.fn().mockRejectedValue(named(name));

    await expect(markFailedWithRetry(markFailed, makeLogger(), { retry: fastRetry })).rejects.toThrow();

    expect(markFailed).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the Lambda has little time left, but still makes the first attempt', async () => {
    const markFailed = vi.fn().mockRejectedValue(networkError());

    await expect(
      markFailedWithRetry(markFailed, makeLogger(), {
        getRemainingMs: () => MARK_FAILED_MIN_REMAINING_MS,
        retry: fastRetry,
      })
    ).rejects.toThrow();

    expect(markFailed).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying while enough Lambda time remains', async () => {
    const markFailed = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValue(undefined);

    await markFailedWithRetry(markFailed, makeLogger(), {
      getRemainingMs: () => MARK_FAILED_MIN_REMAINING_MS + 1,
      retry: fastRetry,
    });

    expect(markFailed).toHaveBeenCalledTimes(2);
  });
});

describe('failure cleanup wiring in agentExecutor', () => {
  const source = readFileSync(join(__dirname, 'agentExecutor.ts'), 'utf8');
  const sliceFrom = (marker: string, endMarker: string) => {
    const start = source.indexOf(marker);
    if (start === -1) throw new Error(`Marker not found in agentExecutor.ts, update this test: ${marker}`);
    const end = source.indexOf(endMarker, start);
    if (end === -1) throw new Error(`End marker not found in agentExecutor.ts, update this test: ${endMarker}`);
    return source.slice(start, end);
  };

  it('retries a guarded markFailed in the main execution failure cleanup', () => {
    const cleanup = sliceFrom("logger.error('[Error] Agent execution failed'", 'inflightSteps.drain()');
    expect(cleanup).toContain('markFailedWithRetry(');
    expect(cleanup).toContain('markFailedIfActive(executionId');
    expect(cleanup).not.toContain('agentExecutionRepository.markFailed(executionId');
  });

  it('retries a guarded markFailed in the subagent dispatch failure cleanup', () => {
    const cleanup = sliceFrom(
      "logger.error('[SubagentDispatch] Fatal error'",
      "'[SubagentDispatch] Cleanup also failed'"
    );
    expect(cleanup).toContain('markFailedWithRetry(');
    expect(cleanup).toContain('markFailedIfActive(childExecutionId');
    expect(cleanup).not.toContain('agentExecutionRepository.markFailed(childExecutionId');
  });
});
