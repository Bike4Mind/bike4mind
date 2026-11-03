import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
const { run, optionsFromEnv } = vi.hoisted(() => ({
  run: vi.fn(),
  optionsFromEnv: vi.fn(),
}));
vi.mock('@workers/cron/storageReconciliation', () => ({ runStorageReconciliation: run, optionsFromEnv }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));
import { SelfHostWorker } from './selfHostWorker';
import { registerStorageReconciliation } from './storageReconciliation';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const HOUR = 60 * 60_000;

/** Non-default thresholds so the passthrough is visible; repair:true proves the wrapper overrides it. */
const FROM_ENV = {
  repair: true,
  driftAlertBytes: 5_000,
  driftedUserCeiling: 7,
  ceilingMinDriftBytes: 9,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T05:59:00Z'));
  run.mockReset().mockResolvedValue(undefined);
  optionsFromEnv.mockReset().mockReturnValue({ ...FROM_ENV });
});
afterEach(() => vi.useRealTimers());

it('runs hourly, recording drift with repair and metrics off', async () => {
  const worker = new SelfHostWorker(logger);
  registerStorageReconciliation(worker);
  worker.start();
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(HOUR - 1);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledExactlyOnceWith({ ...FROM_ENV, repair: false, emitMetrics: false });
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenLastCalledWith({ ...FROM_ENV, repair: false, emitMetrics: false });
  await worker.stop();
});

it('drains an in-flight run instead of cutting it off', async () => {
  let finish!: () => void;
  run.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const worker = new SelfHostWorker(logger);
  registerStorageReconciliation(worker);
  worker.start();
  await vi.advanceTimersByTimeAsync(HOUR);
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
