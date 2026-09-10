import { FabFile } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { moderateImportedKnowledgeFiles } from '@server/s3/moderateImportedKnowledgeFiles';
import { buildKnowledgeModerationDeps } from '@server/s3/knowledgeModerationDeps';

// A scan finishes in seconds, so a row still awaiting moderation past this is stranded, not
// in-flight. Mirrors the chunk sweep's stale-claim threshold.
const MODERATION_STALE_MS = 30 * 60_000;

export interface ModerationRescueSweepArgs {
  /** Whether image moderation is on; forwarded so a disabled scan resolves clean like the live path. */
  enabled: boolean;
  limit: number;
  logger: Logger;
}

/**
 * Recover FabFiles whose moderation scan never completed. `moderationStatus` defaults to 'pending'
 * and is only ever moved to clean/blocked by a scan (isImageServeable withholds a URL until then),
 * so a stale 'pending' is always a failed or never-run scan - never a terminal-by-design state, and
 * therefore always safe to re-scan. This closes the recovery gap the notebook-import path would
 * otherwise leave (a transient scan failure releases the row to 'pending' with nothing to retry it)
 * and, as a bonus, rescues any upload whose objectCreated scan exhausted its Lambda retries.
 *
 * Re-scans in place with the same claim/persist wiring as the import path. Runs from the daily
 * reconcile cron; recovery latency is coarse but the held file is fail-closed (unservable) until it
 * completes, so lag is safe.
 */
export async function runModerationRescueSweep({
  enabled,
  limit,
  logger,
}: ModerationRescueSweepArgs): Promise<{ rescanned: number }> {
  const cutoff = new Date(Date.now() - MODERATION_STALE_MS);

  // A row stranded on 'scanning' (a claim whose scan crashed before releasing it) can never be
  // re-claimed by the pending|null CAS, so first return stale claims to 'pending'.
  await FabFile.updateMany(
    { moderationStatus: 'scanning', updatedAt: { $lt: cutoff } },
    { $set: { moderationStatus: 'pending' } }
  );

  const stuck = await FabFile.find(
    { moderationStatus: 'pending', createdAt: { $lt: cutoff }, filePath: { $exists: true, $nin: [null, ''] } },
    { filePath: 1, userId: 1 }
  )
    .limit(limit)
    .lean<Array<{ filePath: string; userId: string }>>();

  if (!stuck.length) return { rescanned: 0 };

  const deps = buildKnowledgeModerationDeps(logger);
  // Sequential and per file: each row carries its own owner, the set is small (a rare recovery),
  // and moderateImportedKnowledgeFiles never throws - a single bad file cannot abort the sweep.
  for (const file of stuck) {
    await moderateImportedKnowledgeFiles({ filePaths: [file.filePath], userId: file.userId, enabled, ...deps });
  }

  logger.info('[ModerationRescueSweep] re-scanned stranded files', { count: stuck.length });
  return { rescanned: stuck.length };
}
