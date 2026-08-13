/**
 * Drive-as-lake incremental re-sync poll (#1591, E1).
 *
 * Scheduled backstop that keeps each connected Google Drive folder in sync with its data lake:
 * every due connection is re-enqueued onto the SAME ingest handler the manual Re-sync uses
 * (driveLakeIngest), which diffs the folder against the lake and applies adds/updates/removes. This
 * cron only DECIDES who is due and hands off - one delta-aware apply path, no duplicated sync logic.
 * The handler's per-connection `claimForSync` serializes against any manual Re-sync already running.
 *
 * Dark by default: gated on the parent `EnableDataLakes` AND the child `EnableDataLakeDrivePoll`
 * flag, so enabling the feature does not silently start hitting Google on a schedule - an admin opts
 * into polling explicitly. Near-real-time sync (Drive `changes.watch`) is the #1591 E2 follow-up.
 *
 * Schedule: hourly. Enabled: production + dev. Capped per run so a large fleet drains across runs.
 */

import { adminSettingsRepository, connectDB, orgGoogleDriveConnectionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'driveLakeResyncPoll' } });

// A connection is re-polled at most this often. Folder content does not change second-to-second, so
// a several-hour cadence catches same-day edits/deletes while keeping Drive API load modest. The
// ingest handler stamps `lastPolledAt` on every run, so this is measured from the last actual sync.
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Bound the enqueue burst per run so one tick can't flood the ingest queue; the remainder stay "due"
// and are picked up on the next tick. findDueForPoll returns oldest-polled-first, so nothing starves.
const MAX_ENQUEUE_PER_RUN = 200;

export async function handler() {
  const stage = Resource.App.stage;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  // Parent feature gate, then the poll-specific opt-in. Either off => enqueue nothing (stays dark).
  const featureOn = await adminSettingsRepository.getSettingsValue('EnableDataLakes');
  const pollOn = await adminSettingsRepository.getSettingsValue('EnableDataLakeDrivePoll');
  if (!featureOn || !pollOn) {
    logger.info('[driveLakeResyncPoll] disabled; skipping', { featureOn: !!featureOn, pollOn: !!pollOn });
    return { statusCode: 200, body: JSON.stringify({ enqueued: 0, disabled: true }) };
  }

  const cutoff = new Date(Date.now() - POLL_INTERVAL_MS);
  const due = await orgGoogleDriveConnectionRepository.findDueForPoll(cutoff, MAX_ENQUEUE_PER_RUN);

  let enqueued = 0;
  for (const connection of due) {
    // Enqueue by id only; the handler re-reads the connection + folder and claimForSync guards the
    // race with an in-flight manual Re-sync or a prior poll's still-running job.
    await sendToQueue(Resource.driveLakeIngestQueue.url, { connectionId: connection.id });
    enqueued++;
  }

  logger.info('[driveLakeResyncPoll] sweep complete', { due: due.length, enqueued });
  return { statusCode: 200, body: JSON.stringify({ enqueued }) };
}
