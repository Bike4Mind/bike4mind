import { PublishedArtifact } from '@bike4mind/database';
import { PublishThumbnailJobSchema, type PublishThumbnailJob } from '@bike4mind/server-utils/utils/publishThumbnails';

/**
 * Live bundles whose CURRENT version has no thumbnail: never rendered, or rendered for a version
 * that has since been replaced. Mirrors what the worker will accept (apps/workers/src/queueHandlers/
 * publishThumbnail.ts) - reply/fabfile pages and taken-down artifacts have nothing to render.
 */
export function staleThumbnailFilter(): Record<string, unknown> {
  return {
    deletedAt: null,
    'source.kind': 'bundle',
    moderationStatus: { $ne: 'taken_down' },
    sha256Index: { $type: 'string', $ne: '' },
    $expr: { $ne: ['$thumbnail.versionId', '$sha256Index'] },
  };
}

export interface BackfillPublishThumbnailsOptions {
  dryRun: boolean;
  /** Stop after this many matching artifacts (oldest first). Unset means all of them. */
  limit?: number;
  enqueue: (job: PublishThumbnailJob) => Promise<void>;
  log?: (message: string) => void;
}

export interface BackfillPublishThumbnailsResult {
  /** Artifacts the filter selected (bounded by `limit`). */
  selected: number;
  /** Jobs sent - always 0 in a dry run. */
  enqueued: number;
  /** Selected rows whose publicId or version cannot form a valid job; logged and skipped. */
  invalid: number;
}

/**
 * Enqueue a thumbnail render for every artifact staleThumbnailFilter selects. Successfully rendered
 * versions are skipped on re-run. Timed-out and oversized versions remain eligible, so a limited
 * run can select them again. Duplicate jobs replace the thumbnail safely.
 */
export async function backfillPublishThumbnails(
  options: BackfillPublishThumbnailsOptions
): Promise<BackfillPublishThumbnailsResult> {
  const { dryRun, limit, enqueue, log = console.log } = options;
  const query = PublishedArtifact.find(staleThumbnailFilter()).select('publicId sha256Index').sort({ _id: 1 });
  if (limit) query.limit(limit);

  const result: BackfillPublishThumbnailsResult = { selected: 0, enqueued: 0, invalid: 0 };
  for await (const row of query.lean<{ publicId: string; sha256Index: string }>().cursor()) {
    result.selected += 1;
    const job = PublishThumbnailJobSchema.safeParse({ publicId: row.publicId, versionId: row.sha256Index });
    if (!job.success) {
      result.invalid += 1;
      log(`[backfill-publish-thumbnails] skipping ${row.publicId}: not a valid thumbnail job`);
      continue;
    }
    if (dryRun) {
      log(`[backfill-publish-thumbnails] would enqueue ${job.data.publicId} @ ${job.data.versionId.slice(0, 12)}`);
      continue;
    }
    await enqueue(job.data);
    result.enqueued += 1;
  }
  return result;
}
