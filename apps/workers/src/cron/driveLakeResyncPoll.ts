/**
 * Drive-as-lake incremental re-sync poll (#1591, E1).
 *
 * Scheduled backstop that keeps each connected Google Drive folder in sync with its data lake:
 * every due connection is re-enqueued onto the SAME ingest handler the manual Re-sync uses
 * (driveLakeIngest), which diffs the folder against the lake and applies adds/updates/removes. This
 * cron only DECIDES who is due and hands off - one delta-aware apply path, no duplicated sync logic.
 * The handler's per-connection `claimForSync` serializes against any manual Re-sync already running.
 *
 * Most polls hand off an INCREMENTAL pull (the handler goes incremental whenever the connection has a
 * cursor). This cron is also where the periodic FULL re-walk is decided - see FULL_WALK_INTERVAL_MS for
 * the Drive-feed gap that reconcile exists to close.
 *
 * Dark by default: gated on the parent `EnableDataLakes` AND the child `EnableDataLakeDrivePoll`
 * flag, so enabling the feature does not silently start hitting Google on a schedule - an admin opts
 * into polling explicitly. Near-real-time sync (Drive `changes.watch`) is the #1591 E2 follow-up.
 *
 * Schedule: hourly. Enabled: production + dev. Capped per run so a large fleet drains across runs.
 */

import { connectDB, orgGoogleDriveConnectionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import {
  DRIVE_LAKE_POLL_INTERVAL_MS,
  readDriveLakePollFlags,
} from '@server/integrations/google/drive/drivePollSchedule';
import { Config } from '@server/utils/config';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'driveLakeResyncPoll' } });

// How long a connection may go on incremental pulls alone before the next poll forces a FULL folder
// re-walk. Drive's changes feed is per-FILE: dragging a subfolder into or out of the connected root
// mutates only that folder's own `parents` and emits no records for the files underneath it, so no
// number of incremental pulls will ever reclassify them. A periodic re-walk is the reconcile behind
// that gap - it bounds how far the lake can drift from Drive, and it also backstops any single change
// an incremental run had to leave unresolved. Sized well above DRIVE_LAKE_POLL_INTERVAL_MS so the overwhelming
// majority of polls stay O(1), and a connection self-heals within a day rather than on a human's click.
const FULL_WALK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Bound the enqueue burst per run so one tick can't flood the ingest queue; the remainder stay "due"
// and are picked up on the next tick. findDueForPoll returns oldest-polled-first, so nothing starves.
const MAX_ENQUEUE_PER_RUN = 200;

// How many sends are in flight at once. MAX_ENQUEUE_PER_RUN of them one-at-a-time is a full round
// trip per connection inside the cron's timeout; a modest window drains the same list in a fraction
// of it without becoming a burst against SQS itself.
const ENQUEUE_CONCURRENCY = 10;

export async function handler() {
  const stage = Resource.App.stage;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  const { featureOn, pollOn } = await readDriveLakePollFlags();
  if (!featureOn || !pollOn) {
    logger.info('[driveLakeResyncPoll] disabled; skipping', { featureOn, pollOn });
    return { statusCode: 200, body: JSON.stringify({ enqueued: 0, disabled: true }) };
  }

  const now = Date.now();
  const cutoff = new Date(now - DRIVE_LAKE_POLL_INTERVAL_MS);
  const fullWalkCutoff = now - FULL_WALK_INTERVAL_MS;
  const due = await orgGoogleDriveConnectionRepository.findDueForPoll(cutoff, MAX_ENQUEUE_PER_RUN);

  // Bounded-concurrency fan-out with a PER-CONNECTION catch. One unroutable id (a stale queue URL, a
  // throttle) used to reject out of a sequential loop and abandon every connection behind it, so a
  // single bad row could stall the whole sweep tick after tick. Now it costs only itself.
  let enqueued = 0;
  let failed = 0;
  let forcedFullWalks = 0;
  const enqueueOne = async (connection: (typeof due)[number]) => {
    const connectionId = connection.id;
    // A connection that has never recorded a full walk is either brand new (the handler full-walks
    // anyway, so the flag costs nothing) or predates this field - both want a re-walk.
    const forceFullWalk = !connection.lastFullWalkAt || new Date(connection.lastFullWalkAt).getTime() < fullWalkCutoff;
    try {
      // Enqueue by id (plus the re-walk flag); the handler re-reads the connection + folder and
      // claimForSync guards the race with an in-flight manual Re-sync or a prior poll's running job.
      await sendToQueue(Resource.driveLakeIngestQueue.url, {
        connectionId,
        ...(forceFullWalk && { forceFullWalk: true }),
      });
      enqueued++;
      if (forceFullWalk) forcedFullWalks++;
    } catch (e) {
      failed++;
      logger.error('[driveLakeResyncPoll] failed to enqueue connection', {
        connectionId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
  for (let i = 0; i < due.length; i += ENQUEUE_CONCURRENCY) {
    await Promise.all(due.slice(i, i + ENQUEUE_CONCURRENCY).map(enqueueOne));
  }

  // A failed send leaves lastPolledAt untouched, so the connection stays due and the next tick
  // retries it - the count is the operator's signal, not a lost-work marker.
  logger.info('[driveLakeResyncPoll] sweep complete', { due: due.length, enqueued, failed, forcedFullWalks });
  return { statusCode: 200, body: JSON.stringify({ enqueued, failed, forcedFullWalks }) };
}
