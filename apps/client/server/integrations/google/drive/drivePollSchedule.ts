import { adminSettingsRepository } from '@bike4mind/database';

/**
 * The Drive-lake re-sync poll's schedule, shared by the cron that runs it
 * (apps/workers/src/cron/driveLakeResyncPoll.ts) and the drive-connection route that reports it, so the
 * panel can never claim a cadence the cron does not keep.
 */

// A connection is re-polled at most this often. Folder content does not change second-to-second, so
// a several-hour cadence catches same-day edits/deletes while keeping Drive API load modest. The
// ingest handler stamps `lastPolledAt` on every run, so this is measured from the last actual sync.
export const DRIVE_LAKE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Parent feature gate AND the poll-specific opt-in. Either off => the poll stays dark. */
export async function isDriveLakePollEnabled(): Promise<boolean> {
  const [featureOn, pollOn] = await Promise.all([
    adminSettingsRepository.getSettingsValue('EnableDataLakes'),
    adminSettingsRepository.getSettingsValue('EnableDataLakeDrivePoll'),
  ]);
  return !!featureOn && !!pollOn;
}
