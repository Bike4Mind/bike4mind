import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { markFailedWithRetry } from './agentExecutor.failureCleanup';

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn() });
const fast = { initialDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 };
const failure = { message: 'boom' };

describe('markFailedWithRetry', () => {
  it('calls markFailed once when it succeeds first time', async () => {
    const markFailed = vi.fn().mockResolvedValue(undefined);

    await markFailedWithRetry(markFailed, 'exec-1', failure, makeLogger(), fast);

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith('exec-1', failure);
  });

  it('recovers when markFailed throws during a brief outage', async () => {
    const markFailed = vi
      .fn()
      .mockRejectedValueOnce(new Error('MongoNetworkError'))
      .mockRejectedValueOnce(new Error('MongoNetworkError'))
      .mockResolvedValue(undefined);

    await expect(markFailedWithRetry(markFailed, 'exec-1', failure, makeLogger(), fast)).resolves.toBeUndefined();

    expect(markFailed).toHaveBeenCalledTimes(3);
  });

  it('retries errors that are not network-shaped', async () => {
    const markFailed = vi
      .fn()
      .mockRejectedValueOnce(new Error('server selection timed out'))
      .mockResolvedValue(undefined);

    await markFailedWithRetry(markFailed, 'exec-1', failure, makeLogger(), fast);

    expect(markFailed).toHaveBeenCalledTimes(2);
  });

  it('rethrows the last error once retries are spent so the caller can fall back to the sweep', async () => {
    const markFailed = vi.fn().mockRejectedValue(new Error('db down'));

    await expect(
      markFailedWithRetry(markFailed, 'exec-1', failure, makeLogger(), { ...fast, maxRetries: 2 })
    ).rejects.toThrow('db down');

    expect(markFailed).toHaveBeenCalledTimes(3);
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

  it('retries markFailed in the main execution failure cleanup', () => {
    const cleanup = sliceFrom("logger.error('[Error] Agent execution failed'", 'inflightSteps.drain()');
    expect(cleanup).toContain('markFailedWithRetry(');
    expect(cleanup).not.toContain('agentExecutionRepository.markFailed(executionId');
  });

  it('retries markFailed in the subagent dispatch failure cleanup', () => {
    const cleanup = sliceFrom(
      "logger.error('[SubagentDispatch] Fatal error'",
      "'[SubagentDispatch] Cleanup also failed'"
    );
    expect(cleanup).toContain('markFailedWithRetry(');
    expect(cleanup).not.toContain('agentExecutionRepository.markFailed(childExecutionId');
  });
});
