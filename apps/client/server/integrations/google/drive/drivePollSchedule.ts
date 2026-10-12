import { adminSettingsRepository } from '@bike4mind/database';

/**
 * The Drive-lake re-sync poll's schedule, shared by the cron that runs it
 * (apps/workers/src/cron/driveLakeResyncPoll.ts) and the drive-connection route that reports it, so the
 * panel does not claim a cadence the cron does not keep.
 */

// A connection is re-polled at most this often. Folder content does not change second-to-second, so
// a several-hour cadence catches same-day edits/deletes while keeping Drive API load modest. The
// ingest handler stamps `lastPolledAt` on every run, so this is measured from the last actual sync.
export const DRIVE_LAKE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Parent feature gate AND the poll-specific opt-in; the poll stays dark unless both are on. */
export async function readDriveLakePollFlags(): Promise<{ featureOn: boolean; pollOn: boolean }> {
  const [featureOn, pollOn] = await Promise.all([
    adminSettingsRepository.getSettingsValue('EnableDataLakes'),
    adminSettingsRepository.getSettingsValue('EnableDataLakeDrivePoll'),
  ]);
  return { featureOn: !!featureOn, pollOn: !!pollOn };
}

/**
 * Whether the poll actually runs on this deployment. It is an SST cron (infra/cron.ts) the self-host
 * worker runner (apps/workers/src/selfhost/main.ts) does not schedule, so the flags alone would claim
 * automatic sync there. Must change if the self-host runner ever schedules driveLakeResyncPoll.
 */
export async function isDriveLakePollScheduled(): Promise<boolean> {
  if (process.env.B4M_SELF_HOST === 'true') return false;
  const { featureOn, pollOn } = await readDriveLakePollFlags();
  return featureOn && pollOn;
}
