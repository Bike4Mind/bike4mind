import { describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/voiceHoldSweep', () => ({ runVoiceHoldSweep: run }));

import { registerVoiceHoldSweep, VOICE_HOLD_SWEEP_INTERVAL_MS } from './voiceHoldSweep';

function register() {
  let task!: () => Promise<void>;
  const registerScheduledTask = vi.fn(
    (_name: string, _intervalMs: number, fn: () => Promise<void>, _opts?: { runOnStartup?: boolean }) => {
      task = fn;
    }
  );
  registerVoiceHoldSweep({ registerScheduledTask });
  return { registerScheduledTask, task };
}

describe('self-hosted voice hold sweep', () => {
  it('registers a five-minute sweep that also runs on startup', () => {
    const { registerScheduledTask } = register();
    expect(VOICE_HOLD_SWEEP_INTERVAL_MS).toBe(300_000);
    expect(registerScheduledTask).toHaveBeenCalledWith('voiceHoldSweep', 300_000, expect.any(Function), {
      runOnStartup: true,
    });
  });

  it('rejects when any hold failed to settle', async () => {
    const { task } = register();
    run.mockResolvedValueOnce({ candidates: 2, settled: 1, refundedCredits: 5, alreadySettled: 0, failed: 1 });
    await expect(task()).rejects.toThrow('Failed to settle 1 stale voice hold(s)');
  });

  it('resolves when every hold settled or was already settled', async () => {
    const { task } = register();
    run.mockResolvedValueOnce({ candidates: 2, settled: 1, refundedCredits: 5, alreadySettled: 1, failed: 0 });
    await expect(task()).resolves.toBeUndefined();
  });
});
