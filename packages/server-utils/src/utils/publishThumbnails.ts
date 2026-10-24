import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getSourceQueueUrl } from './dlqRegistry';
import { sendToQueue } from './sqs';
import { getPublishedArtifactsStorage } from './storage/index';

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

// Becomes a key segment, so no `/` or `..` can reach S3.
const PUBLIC_ID_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export const PublishThumbnailJobSchema = z.object({
  publicId: z.string().regex(PUBLIC_ID_SEGMENT),
  /** sha256Index of the index.html to depict - the job is dropped once the artifact moves past it. */
  versionId: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PublishThumbnailJob = z.infer<typeof PublishThumbnailJobSchema>;

/** Folder holding every thumbnail render of one artifact. */
export function publishThumbnailPrefix(publicId: string): string {
  return `${PUBLISH_THUMBNAIL_PREFIX}${publicId}/`;
}

/** Each render owns its object, even when duplicate jobs render the same version concurrently. */
export function publishThumbnailKey(publicId: string, versionId: string, renderId: string = randomUUID()): string {
  return `${publishThumbnailPrefix(publicId)}${versionId}-${renderId}.webp`;
}

/** True when `key` is a thumbnail object of `publicId` - checked before a stored key is presigned or deleted. */
export function isPublishThumbnailKeyFor(publicId: string, key: string): boolean {
  const prefix = publishThumbnailPrefix(publicId);
  // Legacy version-only keys remain valid while existing records and signed links expire.
  return (
    key.startsWith(prefix) &&
    /^[0-9a-f]{64}(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.webp$/.test(
      key.slice(prefix.length)
    )
  );
}

/**
 * Delete one detached thumbnail after a reversible takedown. Never sweep its prefix here: a
 * concurrent restore can already have recorded a fresh render under the same artifact folder.
 * Invalid keys are ignored; storage failures are logged without blocking the takedown.
 */
export async function deletePublishThumbnail(
  publicId: string,
  key: string,
  logger: { warn: (message: string) => unknown },
  getStorage: () => { delete(key: string): Promise<void> } = getPublishedArtifactsStorage
): Promise<void> {
  if (!PUBLIC_ID_SEGMENT.test(publicId) || !isPublishThumbnailKeyFor(publicId, key)) return;
  try {
    await getStorage().delete(key);
  } catch (err) {
    logger.warn(`[PUBLISH] thumbnail not deleted for ${publicId}: ${messageOf(err)}`);
  }
}

/** Concurrent prefix deletes while purging many artifacts at once (an account's whole library). */
const DELETE_CONCURRENCY = 8;

/**
 * Delete every thumbnail object of the given artifacts, for owner deletes or account purges.
 * Reversible admin takedowns use deletePublishThumbnail to avoid racing a restore. Callers also
 * clear the `thumbnail` record (PublishedArtifact softDelete, purgeOwnerPublishedArtifacts), so a
 * later restore never signs a missing object.
 *
 * Best-effort and never throws: a failure is logged and must not block the delete that called it.
 * Ids that could never have formed a thumbnail key are skipped. Resolves to the objects deleted.
 */
export async function deletePublishThumbnails(
  publicIds: readonly string[],
  logger: { warn: (message: string) => unknown },
  getStorage: () => { deletePrefix(prefix: string): Promise<number> } = getPublishedArtifactsStorage
): Promise<number> {
  const ids = [...new Set(publicIds)].filter(id => PUBLIC_ID_SEGMENT.test(id));
  if (ids.length === 0) return 0;
  let storage: { deletePrefix(prefix: string): Promise<number> };
  try {
    storage = getStorage();
  } catch (err) {
    logger.warn(`[PUBLISH] thumbnails not deleted for ${ids.length} artifact(s): ${messageOf(err)}`);
    return 0;
  }

  let deleted = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const publicId = ids[cursor++];
      try {
        // Awaited first: `deleted += await ...` would read `deleted` before the other workers add to it.
        const count = await storage.deletePrefix(publishThumbnailPrefix(publicId));
        deleted += count;
      } catch (err) {
        logger.warn(`[PUBLISH] thumbnails not deleted for ${publicId}: ${messageOf(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, ids.length) }, worker));
  return deleted;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
