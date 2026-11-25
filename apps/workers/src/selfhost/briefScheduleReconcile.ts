import { userRepository } from '@bike4mind/database';
import { startScheduledBrief } from '@bike4mind/server-utils/briefs/startBriefComposition';
import { runBriefScheduleReconcile } from '@workers/cron/briefScheduleReconcile';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted briefScheduleReconcile cron's rate(5 minutes) in infra/cron.ts; keep them in step. */
export const BRIEF_SCHEDULE_RECONCILE_INTERVAL_MS = 5 * 60_000;

export function registerBriefScheduleReconcile(worker: Pick<SelfHostWorker, 'registerScheduledTask'>): void {
  worker.registerScheduledTask(
    'briefScheduleReconcile',
    BRIEF_SCHEDULE_RECONCILE_INTERVAL_MS,
    async () => {
      const result = await runBriefScheduleReconcile({
        users: userRepository,
        startScheduledBrief: userId => startScheduledBrief(userId),
        outOfTime: () => false,
      });
      if (result.failed > 0) throw new Error(`Failed to start ${result.failed} scheduled brief(s)`);
    },
    // Due users are claimed by compare-and-set, so a boot run only starts what the next tick would, sooner.
    { runOnStartup: true }
  );
}
