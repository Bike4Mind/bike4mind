import {
  purgeOwnerPublishedArtifacts,
  purgeOwnerPublishedArtifactsBySource,
  type PublishedArtifactSources,
  type PurgedPublishedArtifact,
  type PurgeOwnerPublishedArtifactsResult,
} from '@bike4mind/database';
import { invalidatePublishCdnMany, toCacheTarget } from './invalidatePublishCdn';

interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Take down everything `userId` has published (see purgeOwnerPublishedArtifacts) and purge the
 * CDN for the public pages among them, the same way an owner delete does. Org pages handed to
 * their last publisher are invalidated too, so a cached copy stops naming the deleted owner.
 * Idempotent.
 *
 * Awaited rather than fire-and-forget: this runs once per account deletion, and a Lambda can
 * freeze before a dangling promise sends. invalidatePublishCdnMany never throws.
 */
export async function purgeUserPublishedArtifacts(
  userId: string,
  { deletedBy, logger }: { deletedBy: string; logger?: MinimalLogger }
): Promise<PurgeOwnerPublishedArtifactsResult> {
  const result = await purgeOwnerPublishedArtifacts(userId, { deletedBy });
  await invalidatePublicPages([...result.artifacts, ...result.transferred], logger);
  logger?.info(
    `[PUBLISH] purged published artifacts for user ${userId}: artifacts=${result.artifacts.length} ` +
      `transferred=${result.transferred.length} ` +
      `annotations=${result.annotations} reports=${result.reports} viewAudits=${result.viewAudits}`
  );
  return result;
}

/**
 * Take down what `userId` published from notebooks or files they just deleted (see
 * purgeOwnerPublishedArtifactsBySource) and purge the CDN for the public ones. Idempotent.
 */
export async function unpublishUserArtifactsBySource(
  userId: string,
  sources: PublishedArtifactSources,
  { logger }: { logger?: MinimalLogger } = {}
): Promise<Omit<PurgeOwnerPublishedArtifactsResult, 'transferred'>> {
  const result = await purgeOwnerPublishedArtifactsBySource(userId, sources, { deletedBy: userId });
  await invalidatePublicPages(result.artifacts, logger);
  if (result.artifacts.length > 0) {
    logger?.info(
      `[PUBLISH] took down ${result.artifacts.length} ${sources.kind} artifact(s) for user ${userId} after their sources were deleted`
    );
  }
  return result;
}

async function invalidatePublicPages(artifacts: PurgedPublishedArtifact[], logger?: MinimalLogger) {
  const targets = artifacts.filter(a => a.visibility === 'public').map(toCacheTarget);
  await invalidatePublishCdnMany(targets, logger);
}
