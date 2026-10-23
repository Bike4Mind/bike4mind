import type { Logger } from '@bike4mind/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn<() => Promise<{ failed: number }>>() }));
vi.mock('@workers/cron/creditHoldSweep', () => ({ runCreditHoldSweep: run }));

import { registerCreditHoldSweep } from './creditHoldSweep';
import { SelfHostWorker } from './selfHostWorker';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const FIFTEEN_MINUTES_MS = 15 * 60_000;
let worker: SelfHostWorker;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  run.mockReset();
  run.mockResolvedValue({ failed: 0 });
  worker = new SelfHostWorker(logger);
  registerCreditHoldSweep(worker);
});

afterEach(async () => {
  await worker.stop();
  vi.useRealTimers();
});

describe('local credit hold sweep schedule', () => {
  it('runs at startup and every fifteen minutes without emitting CloudWatch metrics', async () => {
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledExactlyOnceWith({ emitMetrics: false });

    await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES_MS - 1);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith({ emitMetrics: false });
  });

  it('rejects partial refund failures after the shared runner settles', async () => {
    const registerScheduledTask = vi.fn<SelfHostWorker['registerScheduledTask']>();
    registerCreditHoldSweep({ registerScheduledTask });
    const registration = registerScheduledTask.mock.calls[0];
    expect(registration).toBeDefined();
    if (!registration) throw new Error('Credit hold sweep was not registered');
    const [name, interval, task, options] = registration;
    expect({ name, interval, options }).toEqual({
      name: 'creditHoldSweep',
      interval: FIFTEEN_MINUTES_MS,
      options: { runOnStartup: true },
    });
    run.mockResolvedValueOnce({ failed: 2 });

    await expect(task()).rejects.toThrow('Failed to refund 2 expired credit hold(s)');
    expect(run).toHaveBeenCalledExactlyOnceWith({ emitMetrics: false });
  });

  it.each([
    { name: 'partial refund failure', result: { failed: 1 }, error: undefined },
    { name: 'runner rejection', result: undefined, error: new Error('database unavailable') },
  ])('re-arms after a $name', async ({ result, error }) => {
    if (error) run.mockRejectedValueOnce(error);
    else if (result) run.mockResolvedValueOnce(result);

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith('[selfHostWorker] scheduled task "creditHoldSweep" failed', {
      error: error?.message ?? 'Failed to refund 1 expired credit hold(s)',
    });

    await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES_MS);
    expect(run).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('skips overlapping ticks and resumes once the in-flight run finishes', async () => {
    let finish!: (result: { failed: number }) => void;
    run.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    worker.start();

    await vi.advanceTimersByTimeAsync(2 * FIFTEEN_MINUTES_MS);
    expect(run).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    finish({ failed: 0 });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('waits for the in-flight sweep during shutdown and disarms future ticks', async () => {
    let finish!: (result: { failed: number }) => void;
    run.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    worker.start();
    let stopped = false;
    const stopping = worker.stop(1000).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(false);

    finish({ failed: 0 });
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES_MS);
    expect(run).toHaveBeenCalledOnce();
  });
});
