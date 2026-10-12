import { describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/voiceHoldSweep', () => ({ runVoiceHoldSweep: run }));

import { registerVoiceHoldSweep } from './voiceHoldSweep';

describe('self-hosted voice hold sweep', () => {
  it('registers a five-minute sweep and reports partial failures', async () => {
    let task: (() => Promise<void>) | undefined;
    const registerScheduledTask = vi.fn((_name: string, _interval: number, callback: () => Promise<void>) => {
      task = callback;
    });
    registerVoiceHoldSweep({ registerScheduledTask });

    expect(registerScheduledTask).toHaveBeenCalledWith('voiceHoldSweep', 300_000, expect.any(Function));
    run.mockResolvedValueOnce({ candidates: 2, settled: 1, refundedCredits: 5, alreadySettled: 0, failed: 1 });
    await expect(task?.()).rejects.toThrow('Failed to settle 1 stale voice hold(s)');
  });
});
