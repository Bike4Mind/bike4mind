import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
vi.mock('@server/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));
import { SelfHostWorker } from './selfHostWorker';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('daily UTC worker task', () => {
  let worker: SelfHostWorker;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T04:59:30Z'));
    worker = new SelfHostWorker(logger);
  });
  afterEach(async () => {
    await worker.stop();
    vi.useRealTimers();
  });

  it('runs at 05 UTC instead of one day after process start', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    worker.registerDailyUtcTask('batch', 5, run);
    worker.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps bootstrap separate before 05 and does not replay after-05 restart', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    worker.registerDailyUtcTask('batch', 5, run, { runOnStartup: true });
    worker.start();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(2);
    await worker.stop();
    vi.setSystemTime(new Date('2026-09-22T10:00:00Z'));
    worker.start();
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(19 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('coalesces exact-boundary startup and drains its in-flight run', async () => {
    vi.setSystemTime(new Date('2026-09-22T05:00:00Z'));
    let finish!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    worker.registerDailyUtcTask('batch', 5, run, { runOnStartup: true });
    worker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    let drained = false;
    const stopping = worker.stop(20_000).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await stopping;
    expect(drained).toBe(true);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('coalesces missed days and does not replay after a backward clock adjustment', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    worker.registerDailyUtcTask('batch', 5, run);
    worker.start();
    vi.setSystemTime(new Date('2026-09-25T03:00:00Z'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-09-24T04:59:00Z'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('skips an overlapping daily slot and rearms after failure', async () => {
    let reject!: (error: Error) => void;
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          })
      )
      .mockResolvedValue(undefined);
    worker.registerDailyUtcTask('batch', 5, run, { runOnStartup: true });
    worker.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);
    reject(new Error('temporary failure'));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
