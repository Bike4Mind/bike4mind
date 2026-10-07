import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/lakeHealthSweep', () => ({ runLakeHealthSweep: run }));
vi.mock('@server/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));
import { SelfHostWorker } from './selfHostWorker';
import { registerLakeHealthSweep } from './lakeHealthSweep';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T05:59:00Z'));
  run.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());
it('runs at 06 UTC without bootstrap or AWS metrics, then on the next day', async () => {
  const worker = new SelfHostWorker(logger);
  registerLakeHealthSweep(worker);
  worker.start();
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledExactlyOnceWith({ emitMetrics: false });
  await vi.advanceTimersByTimeAsync(86_400_000);
  expect(run).toHaveBeenCalledTimes(2);
  await worker.stop();
});
it('does not replay a missed boundary on restart', async () => {
  vi.setSystemTime(new Date('2026-09-28T06:01:00Z'));
  const worker = new SelfHostWorker(logger);
  registerLakeHealthSweep(worker);
  worker.start();
  await vi.advanceTimersByTimeAsync(86_340_000);
  expect(run).toHaveBeenCalledTimes(1);
  await worker.stop();
});
it('coalesces an overlapping daily slot and drains the existing sweep', async () => {
  let finish!: () => void;
  run.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const worker = new SelfHostWorker(logger);
  registerLakeHealthSweep(worker);
  worker.start();
  await vi.advanceTimersByTimeAsync(60_000 + 86_400_000);
  expect(run).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stop = worker.stop(1000).then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(stopped).toBe(false);
  finish();
  await stop;
  expect(stopped).toBe(true);
});
