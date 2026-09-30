import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const { mockRunQuestTimeoutSweep } = vi.hoisted(() => ({ mockRunQuestTimeoutSweep: vi.fn() }));

vi.mock('@server/cron/questTimeoutSweep', () => ({ runQuestTimeoutSweep: mockRunQuestTimeoutSweep }));
vi.mock('@server/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));

const { SelfHostWorker } = await import('./selfHostWorker');
const { registerQuestTimeoutSweep, QUEST_TIMEOUT_SWEEP_INTERVAL_MS } = await import('./questTimeoutSweep');

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

describe('registerQuestTimeoutSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockRunQuestTimeoutSweep.mockResolvedValue({ status: 'OK', recovered: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps at startup and then every 5 minutes, without CloudWatch metrics', async () => {
    expect(QUEST_TIMEOUT_SWEEP_INTERVAL_MS).toBe(5 * 60_000);
    const worker = new SelfHostWorker(mockLogger);
    registerQuestTimeoutSweep(worker);
    worker.start();

    expect(mockRunQuestTimeoutSweep).toHaveBeenCalledTimes(1);
    expect(mockRunQuestTimeoutSweep).toHaveBeenCalledWith({ emitMetrics: false });

    await vi.advanceTimersByTimeAsync(QUEST_TIMEOUT_SWEEP_INTERVAL_MS - 1);
    expect(mockRunQuestTimeoutSweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockRunQuestTimeoutSweep).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(QUEST_TIMEOUT_SWEEP_INTERVAL_MS);
    expect(mockRunQuestTimeoutSweep).toHaveBeenCalledTimes(3);
    await worker.stop();
  });

  it('skips ticks while a sweep is still running, and stop drains it', async () => {
    let finishRun!: () => void;
    mockRunQuestTimeoutSweep.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishRun = () => resolve({ status: 'OK', recovered: 0 });
        })
    );
    const worker = new SelfHostWorker(mockLogger);
    registerQuestTimeoutSweep(worker);
    worker.start();

    await vi.advanceTimersByTimeAsync(2 * QUEST_TIMEOUT_SWEEP_INTERVAL_MS);
    expect(mockRunQuestTimeoutSweep).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('"questTimeoutSweep" still running'));

    let stopped = false;
    const stopping = worker.stop(1000).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finishRun();
    await stopping;

    await vi.advanceTimersByTimeAsync(QUEST_TIMEOUT_SWEEP_INTERVAL_MS);
    expect(mockRunQuestTimeoutSweep).toHaveBeenCalledTimes(1);
  });

  it('logs a failed sweep and runs again on the next tick', async () => {
    mockRunQuestTimeoutSweep.mockRejectedValueOnce(new Error('Database unavailable'));
    const worker = new SelfHostWorker(mockLogger);
    registerQuestTimeoutSweep(worker);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('scheduled task "questTimeoutSweep" failed'),
      {
        error: 'Database unavailable',
      }
    );
    await vi.advanceTimersByTimeAsync(QUEST_TIMEOUT_SWEEP_INTERVAL_MS);
    expect(mockRunQuestTimeoutSweep).toHaveBeenCalledTimes(2);
    await worker.stop();
  });
});
