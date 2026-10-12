import { runVoiceHoldSweep } from '@workers/cron/voiceHoldSweep';
import type { SelfHostWorker } from './selfHostWorker';

// Self-host twin of the `voiceHoldSweep` SST cron (infra/cron.ts); keep the schedules in step.
export function registerVoiceHoldSweep(worker: Pick<SelfHostWorker, 'registerScheduledTask'>): void {
  worker.registerScheduledTask('voiceHoldSweep', 5 * 60 * 1000, async () => {
    const result = await runVoiceHoldSweep();
    if (result.failed > 0) throw new Error(`Failed to settle ${result.failed} stale voice hold(s)`);
  });
}
