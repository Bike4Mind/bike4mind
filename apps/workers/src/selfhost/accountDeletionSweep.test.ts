import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/accountDeletionSweep', () => ({ runAccountDeletionSweep: run }));
import { SelfHostWorker } from './selfHostWorker';
import { registerAccountDeletionSweep } from './accountDeletionSweep';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
let worker: SelfHostWorker;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  run.mockResolvedValue({ deleted: 0 });
  worker = new SelfHostWorker(logger);
  registerAccountDeletionSweep(worker);
});
afterEach(async () => {
  await worker.stop();
  vi.useRealTimers();
});

describe('local account deletion sweep schedule', () => {
  it('runs the sweep at 05:00 UTC and again a day later', async () => {
    vi.setSystemTime(new Date('2026-09-30T04:59:00Z'));
    worker.start();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledExactlyOnceWith();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
