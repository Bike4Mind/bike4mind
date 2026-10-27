import { randomUUID } from 'node:crypto';
import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { buildThumbnailDocument, type DroppedAssets } from '@server/services/publish/buildThumbnailDocument';
import { PublishedArtifact, recordPublishedArtifactThumbnail } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { getPublishedArtifactsStorage } from '@bike4mind/server-utils/utils/storage/index';
import {
  PublishThumbnailJobSchema,
  deletePublishThumbnail,
  isPublishThumbnailKeyFor,
  publishThumbnailKey,
  type PublishThumbnailJob,
} from '@bike4mind/server-utils/utils/publishThumbnails';
import { PUBLISH_HOST } from '@server/services/publish/validateBundle';
import { invokeThumbnailRenderer, ThumbnailRendererError } from '@workers/media/invokeThumbnailRenderer';
import {
  MAX_THUMBNAIL_DOCUMENT_BYTES,
  MAX_THUMBNAIL_IMAGE_BYTES,
  isWebp,
  type ThumbnailRenderRequest,
  type ThumbnailRenderResponse,
} from '@workers/media/thumbnailRendererContract';

const THUMBNAIL_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/**
 * Where the document waits for the renderer to fetch it. Under `drafts/` so the bucket's 1-day
 * expire-drafts rule (infra/buckets.ts) reaps any copy the delete below misses; a draft id is a
 * UUID, so this segment never collides with a real draft.
 */
export const THUMBNAIL_STAGING_PREFIX = 'drafts/thumbnail-renders/';
/** Lifetime of the renderer's link to the staged document (s); it is fetched at invoke start. */
const STAGED_DOCUMENT_URL_TTL_SECONDS = 5 * 60;

export type PublishThumbnailOutcome =
  'rendered' | 'missing' | 'unsupported' | 'superseded' | 'timed-out' | 'too-large' | 'discarded';

export type RenderThumbnail = (request: ThumbnailRenderRequest) => Promise<ThumbnailRenderResponse>;

interface ThumbnailArtifactLean {
  publicId: string;
  source: { kind: string };
  storageKeyPrefix?: string;
  sha256Index?: string;
  manifest?: Array<{ path: string; mimeType: string }>;
  moderationStatus?: string;
}

/**
 * Render and store one owner-only thumbnail (job contract: packages/server-utils/src/utils/publishThumbnails.ts).
 *
 * This handler holds the access (database, private bucket) and never runs page code. It builds the
 * fully inlined document, stages it, and has the renderer function - which has no application
 * credentials or permissions (media/publishThumbnailRenderer.ts) - turn it into a WebP, which it
 * then validates, stores and records.
 *
 * Retry semantics, per the dispatchWithLogger contract: anything that says nothing about the
 * artifact itself - the renderer failing or answering badly, storage or the database erroring -
 * throws, so SQS redelivers and eventually dead-letters it. Outcomes that a retry cannot change are
 * consumed: the artifact is gone or not a bundle, a newer version superseded the job, the document
 * is too large to render, or the page wedged the renderer past its deadline (an author's busy loop
 * would do that every time).
 */
export async function processPublishThumbnailJob(
  job: PublishThumbnailJob,
  logger: Pick<Logger, 'info' | 'warn'>,
  render: RenderThumbnail = invokeThumbnailRenderer
): Promise<PublishThumbnailOutcome> {
  const artifact = await PublishedArtifact.findOne({ publicId: job.publicId, deletedAt: null })
    .select('publicId source storageKeyPrefix sha256Index manifest moderationStatus')
    .lean<ThumbnailArtifactLean | null>();
  if (!artifact) return 'missing';
  if (artifact.source.kind !== 'bundle' || !artifact.storageKeyPrefix || artifact.moderationStatus === 'taken_down') {
    return 'unsupported';
  }
  if (artifact.sha256Index !== job.versionId) return 'superseded';

  const storage = getPublishedArtifactsStorage();
  const prefix = artifact.storageKeyPrefix;
  const document = await buildThumbnailDocument({
    versionId: job.versionId,
    manifest: artifact.manifest ?? [],
    load: path => storage.download(`${prefix}${path}`),
    appOrigin: process.env.APP_URL || (PUBLISH_HOST ? `https://${PUBLISH_HOST}` : ''),
  });
  if (!document) return 'superseded';
  const dropped = describeDroppedAssets(document.droppedAssets);
  if (dropped) logger.info(`[publishThumbnail] ${job.publicId} rendering without ${dropped}`);

  const documentBytes = Buffer.from(document.srcdoc, 'utf-8');
  if (documentBytes.length > MAX_THUMBNAIL_DOCUMENT_BYTES) {
    logger.warn(`[publishThumbnail] ${job.publicId} document is ${documentBytes.length} bytes; not rendering it`);
    return 'too-large';
  }

  const stagingKey = `${THUMBNAIL_STAGING_PREFIX}${randomUUID()}.html`;
  await storage.upload(documentBytes, stagingKey, { ContentType: 'text/html; charset=utf-8' });
  let response: ThumbnailRenderResponse;
  try {
    const documentUrl = await storage.getSignedUrl(stagingKey, 'get', { expiresIn: STAGED_DOCUMENT_URL_TTL_SECONDS });
    response = await render({ documentUrl, allowedScriptUrls: document.allowedScriptUrls });
  } finally {
    await storage.delete(stagingKey).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[publishThumbnail] ${job.publicId} staged document left for the drafts expiry: ${reason}`);
    });
  }

  if (response.status === 'timed-out') {
    logger.warn(`[publishThumbnail] ${job.publicId} render timed out; keeping the previous thumbnail`);
    return 'timed-out';
  }
  // The renderer is the untrusted side of this call: store nothing but a bounded WebP.
  const image = Buffer.from(response.imageBase64, 'base64');
  if (image.length > MAX_THUMBNAIL_IMAGE_BYTES || !isWebp(image)) {
    throw new ThumbnailRendererError(`thumbnail renderer returned ${image.length} bytes that are not a usable WebP`);
  }

  const key = publishThumbnailKey(job.publicId, job.versionId);
  // Each render owns its immutable key, including retries and restores of the same version.
  // Windowed signing in apps/client/server/services/publish/thumbnailUrl.ts keeps its URL cacheable.
  await storage.upload(image, key, { ContentType: 'image/webp', CacheControl: THUMBNAIL_CACHE_CONTROL });

  const recorded = await recordPublishedArtifactThumbnail(job.publicId, {
    key,
    versionId: job.versionId,
    renderedAt: new Date(),
  });
  if (!recorded) {
    // This render's unique key cannot be referenced by another render of the same version.
    await deletePublishThumbnail(job.publicId, key, logger, () => storage);
    return 'discarded';
  }
  if (recorded.replacedKey && isPublishThumbnailKeyFor(job.publicId, recorded.replacedKey)) {
    await deletePublishThumbnail(job.publicId, recorded.replacedKey, logger, () => storage);
  }
  return 'rendered';
}

/** Paths listed per reason in the log line; the count still covers all of them. */
const LOGGED_PATHS_PER_REASON = 5;

/**
 * `N asset(s): missing 2 ["a.png","b.css"], oversized 1 ["big.png"]`, or undefined when nothing was
 * dropped. Paths are author-chosen, so they are JSON-quoted to keep the log on one line.
 */
export function describeDroppedAssets(dropped: DroppedAssets): string | undefined {
  const reasons = (['missing', 'oversized', 'failed'] as const).filter(reason => dropped[reason].length);
  if (!reasons.length) return undefined;
  const total = reasons.reduce((sum, reason) => sum + dropped[reason].length, 0);
  const parts = reasons.map(
    reason => `${reason} ${dropped[reason].length} ${JSON.stringify(dropped[reason].slice(0, LOGGED_PATHS_PER_REASON))}`
  );
  return `${total} asset(s): ${parts.join(', ')}`;
}

export const dispatch = dispatchWithLogger(async (event, _context, logger) => {
  const record = event.Records[0];
  if (!record) {
    logger.warn('Skipping publish-thumbnail event with no records');
    return;
  }
  let job: PublishThumbnailJob;
  try {
    job = PublishThumbnailJobSchema.parse(JSON.parse(record.body));
  } catch (err) {
    logger.warn(`Skipping malformed publish-thumbnail message: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  logger.updateMetadata({ handler: 'publishThumbnail', publicId: job.publicId, versionId: job.versionId });
  const outcome = await processPublishThumbnailJob(job, logger);
  logger.info(`[publishThumbnail] ${job.publicId} ${outcome}`);
});
