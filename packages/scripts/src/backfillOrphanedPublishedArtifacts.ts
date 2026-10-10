import { PublishedArtifact, User, purgeOwnerPublishedArtifacts } from '@bike4mind/database';
import { Types } from 'mongoose';

export const ORPHAN_BACKFILL_DELETED_BY = 'system:orphaned-owner-backfill';

const OBJECT_ID_HEX = /^[a-f0-9]{24}$/i;

export interface BackfillOrphanedPublishedArtifactsOptions {
  dryRun: boolean;
  /** Owner ids checked against the users collection per query. */
  batchSize?: number;
  log?: (message: string) => void;
}

export interface BackfillOrphanedPublishedArtifactsResult {
  /** Distinct owners of live artifacts whose user row no longer exists. */
  orphanedOwners: number;
  /** Live artifacts belonging to those owners - removed, or in a dry run, that would be. */
  artifacts: number;
}

/**
 * Soft-delete the published artifacts (and their child rows) of users who no longer exist, i.e.
 * accounts deleted before account deletion purged them. Goes through the same
 * purgeOwnerPublishedArtifacts the delete path uses, so the result is identical and a re-run
 * is a no-op. An ownerId that is not a 24-hex ObjectId can never match a user, so it counts
 * as orphaned too.
 *
 * Does NOT purge the CDN (that client lives in apps/client): a cached public copy expires on
 * its own short TTL, and the serve route already refuses artifacts with no live owner.
 */
export async function backfillOrphanedPublishedArtifacts(
  options: BackfillOrphanedPublishedArtifactsOptions
): Promise<BackfillOrphanedPublishedArtifactsResult> {
  const { dryRun, batchSize = 500, log = console.log } = options;

  const ownerIds = (await PublishedArtifact.distinct<string>('ownerId', { deletedAt: null })).map(String);

  const orphans: string[] = [];
  for (let i = 0; i < ownerIds.length; i += batchSize) {
    const batch = ownerIds.slice(i, i + batchSize);
    const valid = batch.filter(id => OBJECT_ID_HEX.test(id));
    const existing = await User.collection
      .find({ _id: { $in: valid.map(id => new Types.ObjectId(id)) } }, { projection: { _id: 1 } })
      .toArray();
    const found = new Set(existing.map(u => String(u._id)));
    orphans.push(...batch.filter(id => !found.has(id)));
  }

  let artifacts = 0;
  for (const ownerId of orphans) {
    if (dryRun) {
      const count = await PublishedArtifact.countDocuments({ ownerId, deletedAt: null });
      artifacts += count;
      log(`[backfill-orphaned-published-artifacts] owner ${ownerId}: would remove ${count} artifact(s)`);
    } else {
      const result = await purgeOwnerPublishedArtifacts(ownerId, { deletedBy: ORPHAN_BACKFILL_DELETED_BY });
      artifacts += result.artifacts.length;
      log(
        `[backfill-orphaned-published-artifacts] owner ${ownerId}: removed ${result.artifacts.length} artifact(s), ` +
          `annotations=${result.annotations} reports=${result.reports} viewAudits=${result.viewAudits}`
      );
    }
  }

  log(
    `[backfill-orphaned-published-artifacts] ${ownerIds.length} owner(s) with live artifacts; ` +
      `${orphans.length} orphaned; ${dryRun ? 'would remove' : 'removed'} ${artifacts} artifact(s)`
  );
  return { orphanedOwners: orphans.length, artifacts };
}
