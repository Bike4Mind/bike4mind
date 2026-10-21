import { describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/realtimeConnectionSweep', () => ({ runRealtimeConnectionSweep: run }));

import { registerRealtimeConnectionSweep, REALTIME_CONNECTION_SWEEP_INTERVAL_MS } from './realtimeConnectionSweep';

function register() {
  let task!: () => Promise<void>;
  const registerScheduledTask = vi.fn(
    (_name: string, _intervalMs: number, fn: () => Promise<void>, _opts?: { runOnStartup?: boolean }) => {
      task = fn;
    }
  );
  registerRealtimeConnectionSweep({ registerScheduledTask });
  return { registerScheduledTask, task };
}

describe('self-hosted realtime connection sweep', () => {
  it('registers a five-minute sweep that also runs on startup', () => {
    const { registerScheduledTask } = register();
    expect(REALTIME_CONNECTION_SWEEP_INTERVAL_MS).toBe(300_000);
    expect(registerScheduledTask).toHaveBeenCalledWith('realtimeConnectionSweep', 300_000, expect.any(Function), {
      runOnStartup: true,
    });
  });

  it('runs the shared sweep when the task fires', async () => {
    const { task } = register();
    run.mockResolvedValueOnce(undefined);

    await task();

    expect(run).toHaveBeenCalledTimes(1);
  });
});
