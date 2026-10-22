import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/apiKeyBaselineCalculation', () => ({ runApiKeyBaselineCalculation: run }));
import { SelfHostWorker } from './selfHostWorker';
import { registerApiKeyBaselineCalculation } from './apiKeyBaselineCalculation';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
let worker: SelfHostWorker;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  run.mockResolvedValue({ errors: 0 });
  worker = new SelfHostWorker(logger);
  registerApiKeyBaselineCalculation(worker);
});
afterEach(async () => {
  await worker.stop();
  vi.useRealTimers();
});

describe('local API key baseline schedule', () => {
  it('rejects partial failures after the shared runner settles', async () => {
    let task!: () => Promise<void>;
    registerApiKeyBaselineCalculation({
      registerDailyUtcTask: (_name, _hour, fn) => {
        task = fn;
      },
    });
    run.mockResolvedValueOnce({ processed: 1, errors: 1 });
    await expect(task()).rejects.toThrow('API key baseline calculation failed for 1 key(s)');
  });
  it('waits for 02:00 UTC instead of bootstrapping', async () => {
    vi.setSystemTime(new Date('2026-09-30T01:59:00Z'));
    worker.start();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledExactlyOnceWith();
  });
  it('runs at exactly 02:00, but a later restart waits until tomorrow', async () => {
    vi.setSystemTime(new Date('2026-09-30T02:00:00Z'));
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    await worker.stop();
    vi.setSystemTime(new Date('2026-09-30T02:01:00Z'));
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(86_340_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('coalesces missed days and re-arms after a failed run', async () => {
    run.mockRejectedValueOnce(new Error('database unavailable'));
    vi.setSystemTime(new Date('2026-09-30T01:59:00Z'));
    worker.start();
    vi.setSystemTime(new Date('2026-10-02T03:00:00Z'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(82_740_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('does not overlap and waits for in-flight work during bounded shutdown', async () => {
    let finish!: () => void;
    run.mockImplementationOnce(() =>
      new Promise<void>(resolve => {
        finish = () => resolve();
      }).then(() => ({ errors: 0 }))
    );
    vi.setSystemTime(new Date('2026-09-30T02:00:00Z'));
    worker.start();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = worker.stop(1000).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalledOnce();
  });
});
