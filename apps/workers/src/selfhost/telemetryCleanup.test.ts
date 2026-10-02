import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/telemetryCleanup', () => ({ runTelemetryCleanup: run }));
import { SelfHostWorker } from './selfHostWorker';
import { registerTelemetryCleanup } from './telemetryCleanup';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
let worker: SelfHostWorker;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  run.mockResolvedValue({ scanned: 0 });
  worker = new SelfHostWorker(logger);
  registerTelemetryCleanup(worker);
});
afterEach(async () => {
  await worker.stop();
  vi.useRealTimers();
});

describe('local telemetry retention schedule', () => {
  it('waits for 03:00 UTC instead of bootstrapping', async () => {
    vi.setSystemTime(new Date('2026-09-30T02:59:00Z'));
    worker.start();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledExactlyOnceWith();
  });
  it('runs at exactly 03:00, but a later restart waits until tomorrow', async () => {
    vi.setSystemTime(new Date('2026-09-30T03:00:00Z'));
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    await worker.stop();
    vi.setSystemTime(new Date('2026-09-30T03:01:00Z'));
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(86_340_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('coalesces missed days and re-arms after a failed run', async () => {
    run.mockRejectedValueOnce(new Error('database unavailable'));
    vi.setSystemTime(new Date('2026-09-30T02:59:00Z'));
    worker.start();
    vi.setSystemTime(new Date('2026-10-02T04:00:00Z'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(82_740_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('does not overlap and waits for in-flight work during bounded shutdown', async () => {
    let finish!: () => void;
    run.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    vi.setSystemTime(new Date('2026-09-30T03:00:00Z'));
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
  it('stops after the grace period when a cleanup never settles', async () => {
    run.mockImplementationOnce(() => new Promise<void>(() => {}));
    vi.setSystemTime(new Date('2026-09-30T02:59:00Z'));
    worker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledOnce();
    let stopped = false;
    const stop = worker.stop(1000).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stop;
    expect(stopped).toBe(true);
  });
});
