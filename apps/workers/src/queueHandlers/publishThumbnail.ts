import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { buildThumbnailDocument } from '@server/services/publish/buildThumbnailDocument';
import { PublishedArtifact, recordPublishedArtifactThumbnail } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { getPublishedArtifactsStorage } from '@bike4mind/server-utils/utils/storage/index';
import {
  PublishThumbnailJobSchema,
  isPublishThumbnailKeyFor,
  publishThumbnailKey,
  type PublishThumbnailJob,
} from '@bike4mind/server-utils/utils/publishThumbnails';
import { PUBLISH_HOST } from '@server/services/publish/validateBundle';
import { openLambdaChromiumContext } from '@workers/media/launchLambdaChromium';
import {
  renderHtmlThumbnail,
  ThumbnailRenderTimeoutError,
  type OpenThumbnailContext,
} from '@workers/media/renderHtmlThumbnail';

export type PublishThumbnailOutcome = 'rendered' | 'missing' | 'unsupported' | 'superseded' | 'timed-out' | 'discarded';

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
 * Retry semantics, per the dispatchWithLogger contract: anything that says nothing about the
 * artifact itself - the browser failing to launch, storage or the database erroring - throws, so
 * SQS redelivers and eventually dead-letters it. Outcomes that a retry cannot change are consumed:
 * the artifact is gone or not a bundle, a newer version superseded the job, or the page wedged the
 * renderer past its deadline (an author's busy loop would do that every time).
 */
export async function processPublishThumbnailJob(
  job: PublishThumbnailJob,
  logger: Pick<Logger, 'info' | 'warn'>,
  openContext: OpenThumbnailContext = openLambdaChromiumContext
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
  if (document.droppedAssets.length) {
    logger.info(`[publishThumbnail] ${job.publicId} rendering without ${document.droppedAssets.length} asset(s)`);
  }

  let image: Buffer;
  try {
    image = await renderHtmlThumbnail({
      srcdoc: document.srcdoc,
      allowedScriptUrls: document.allowedScriptUrls,
      openContext,
    });
  } catch (err) {
    if (err instanceof ThumbnailRenderTimeoutError) {
      logger.warn(`[publishThumbnail] ${job.publicId} render timed out; keeping the previous thumbnail`);
      return 'timed-out';
    }
    throw err;
  }

  const key = publishThumbnailKey(job.publicId, job.versionId);
  await storage.upload(image, key, { ContentType: 'image/webp', CacheControl: 'private, max-age=86400' });

  const recorded = await recordPublishedArtifactThumbnail(job.publicId, {
    key,
    versionId: job.versionId,
    renderedAt: new Date(),
  });
  if (!recorded) {
    // Published over or deleted mid-render: nothing points at this object, so do not leave it behind.
    await storage.delete(key).catch(() => undefined);
    return 'discarded';
  }
  if (recorded.replacedKey && isPublishThumbnailKeyFor(job.publicId, recorded.replacedKey)) {
    await storage.delete(recorded.replacedKey).catch(() => undefined);
  }
  return 'rendered';
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
