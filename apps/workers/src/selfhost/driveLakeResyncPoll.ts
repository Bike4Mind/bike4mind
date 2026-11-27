import { runDriveLakeResyncPoll } from '@workers/cron/driveLakeResyncPoll';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted driveLakeResyncPoll cron's rate(1 hour) in infra/cron.ts. */
export const DRIVE_LAKE_RESYNC_POLL_INTERVAL_MS = 60 * 60_000;

export function registerDriveLakeResyncPoll(worker: Pick<SelfHostWorker, 'registerScheduledTask'>): void {
  worker.registerScheduledTask('driveLakeResyncPoll', DRIVE_LAKE_RESYNC_POLL_INTERVAL_MS, async () => {
    await runDriveLakeResyncPoll();
  });
}
