import { runVoiceHoldSweep } from '@workers/cron/voiceHoldSweep';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted voiceHoldSweep cron's rate(5 minutes) in infra/cron.ts; keep them in step. */
export const VOICE_HOLD_SWEEP_INTERVAL_MS = 5 * 60_000;

export function registerVoiceHoldSweep(worker: Pick<SelfHostWorker, 'registerScheduledTask'>): void {
  worker.registerScheduledTask(
    'voiceHoldSweep',
    VOICE_HOLD_SWEEP_INTERVAL_MS,
    async () => {
      const result = await runVoiceHoldSweep();
      if (result.failed > 0) throw new Error(`Failed to settle ${result.failed} stale voice hold(s)`);
    },
    // Staleness is judged from the hold's start at run time, so a boot run settles only what the
    // next tick would, sooner, and a worker that restarts inside one interval still sweeps.
    { runOnStartup: true }
  );
}
