import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/signupIpRetention', () => ({ runSignupIpRetention: run }));
import { SelfHostWorker } from './selfHostWorker';
import { registerSignupIpRetention } from './signupIpRetention';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
let worker: SelfHostWorker;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  run.mockResolvedValue({ truncatedCount: 0 });
  worker = new SelfHostWorker(logger);
  registerSignupIpRetention(worker);
});
afterEach(async () => {
  await worker.stop();
  vi.useRealTimers();
});

describe('local signup IP retention schedule', () => {
  it('runs the sweep at 03:00 UTC and again a day later', async () => {
    vi.setSystemTime(new Date('2026-09-30T02:59:00Z'));
    worker.start();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledExactlyOnceWith();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
