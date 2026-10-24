import { z } from 'zod';
import { getSourceQueueUrl } from './dlqRegistry';
import { sendToQueue } from './sqs';

/**
 * Owner-only thumbnails of published bundles, shared by the producers (publish finalize, restore,
 * AI revise, the backfill script) and the consumer (apps/workers/src/queueHandlers/publishThumbnail.ts).
 *
 * Objects live in the PRIVATE published-artifacts bucket under this prefix. The serve route can
 * never reach them: every key it reads sits under an artifact's `{tier}/{scopeId}/{slug}/`
 * storageKeyPrefix, and no tier is named `publish-thumbnails`. They are handed out only as a
 * short-lived presigned GET on the owner's own management listing (GET /api/publish/artifacts?mine=true).
 */
export const PUBLISH_THUMBNAIL_PREFIX = 'publish-thumbnails/';

export const PublishThumbnailJobSchema = z.object({
  // Becomes a key segment, so no `/` or `..` can reach S3.
  publicId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** sha256Index of the index.html to depict - the job is dropped once the artifact moves past it. */
  versionId: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PublishThumbnailJob = z.infer<typeof PublishThumbnailJobSchema>;

export function publishThumbnailKey(publicId: string, versionId: string): string {
  return `${PUBLISH_THUMBNAIL_PREFIX}${publicId}/${versionId}.webp`;
}

/** True when `key` is a thumbnail object of `publicId` - checked before a stored key is presigned or deleted. */
export function isPublishThumbnailKeyFor(publicId: string, key: string): boolean {
  const prefix = `${PUBLISH_THUMBNAIL_PREFIX}${publicId}/`;
  return key.startsWith(prefix) && /^[0-9a-f]{64}\.webp$/.test(key.slice(prefix.length));
}

/**
 * Ask the worker to render a thumbnail for one artifact version. Never throws: a thumbnail is
 * cosmetic, so a publish must succeed even when the queue is down or was never provisioned (the
 * self-host stack has no renderer and no queue URL; the card keeps its generated cover there).
 * Resolves true only when the message was accepted.
 */
export async function enqueuePublishThumbnail(
  job: PublishThumbnailJob,
  logger: { warn: (message: string) => unknown }
): Promise<boolean> {
  const parsed = PublishThumbnailJobSchema.safeParse(job);
  if (!parsed.success) {
    logger.warn(`[PUBLISH] thumbnail not queued for ${job.publicId}: invalid job`);
    return false;
  }
  let queueUrl: string;
  try {
    queueUrl = getSourceQueueUrl('publishThumbnailQueue');
  } catch {
    return false;
  }
  try {
    await sendToQueue(queueUrl, parsed.data);
    return true;
  } catch (err) {
    logger.warn(
      `[PUBLISH] thumbnail enqueue failed for ${job.publicId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}
