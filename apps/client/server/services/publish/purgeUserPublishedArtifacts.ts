import { purgeOwnerPublishedArtifacts, type PurgeOwnerPublishedArtifactsResult } from '@bike4mind/database';
import { invalidatePublishCdn, toCacheTarget } from './invalidatePublishCdn';

interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Take down everything `userId` has published (see purgeOwnerPublishedArtifacts) and purge the
 * CDN for the public pages among them, the same way an owner delete does. Idempotent.
 *
 * Awaited one at a time rather than fire-and-forget: this runs once per account deletion, and a
 * Lambda can freeze before a dangling promise sends. invalidatePublishCdn never throws.
 */
export async function purgeUserPublishedArtifacts(
  userId: string,
  { deletedBy, logger }: { deletedBy: string; logger?: MinimalLogger }
): Promise<PurgeOwnerPublishedArtifactsResult> {
  const result = await purgeOwnerPublishedArtifacts(userId, { deletedBy });
  for (const artifact of result.artifacts) {
    if (artifact.visibility === 'public') await invalidatePublishCdn(toCacheTarget(artifact), logger);
  }
  logger?.info(
    `[PUBLISH] purged published artifacts for user ${userId}: artifacts=${result.artifacts.length} ` +
      `annotations=${result.annotations} reports=${result.reports} viewAudits=${result.viewAudits}`
  );
  return result;
}
