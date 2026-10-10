import {
  Annotation,
  PublishedArtifact,
  findMissingUserIds,
  hideDeletedAuthorAnnotations,
  findTransferableOrgArtifacts,
  purgeOwnerPublishedArtifacts,
} from '@bike4mind/database';

export const ORPHAN_BACKFILL_DELETED_BY = 'system:orphaned-owner-backfill';

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
  /** Org-tier artifacts handed to their last publisher instead - or in a dry run, that would be. */
  transferred: number;
  /** Distinct authors of live annotations whose user row no longer exists. */
  deletedAuthors: number;
  /** Their live annotations, moved to the deleted-account dustbin - or in a dry run, that would be.
   *  A dry run also counts ones on pages the owner pass above would remove. */
  annotations: number;
}

/**
 * Soft-delete the published artifacts (and their child rows) of users who no longer exist, i.e.
 * accounts deleted before account deletion purged them. Goes through the same
 * purgeOwnerPublishedArtifacts the delete path uses, so the result is identical (including
 * handing org pages to a still-existing last publisher) and a re-run is a no-op. An ownerId that is not a 24-hex ObjectId can never match a user, so it counts
 * as orphaned too.
 *
 * Then does the same for annotation authors: a deleted author's remaining live annotations
 * (on other people's pages) go to the dustbin via hideDeletedAuthorAnnotations, as the delete
 * path does, and expire 90 days later.
 *
 * Does NOT purge the CDN (that client lives in apps/client). It does not need to: the serve
 * route already 404s artifacts with no live owner, so a cached public copy stops serving once
 * its s-maxage (1 hour) runs out after that check is deployed, whether or not this has run.
 */
export async function backfillOrphanedPublishedArtifacts(
  options: BackfillOrphanedPublishedArtifactsOptions
): Promise<BackfillOrphanedPublishedArtifactsResult> {
  const { dryRun, batchSize = 500, log = console.log } = options;

  const ownerIds = (await PublishedArtifact.distinct<string>('ownerId', { deletedAt: null })).map(String);

  const orphans: string[] = [];
  for (let i = 0; i < ownerIds.length; i += batchSize) {
    orphans.push(...(await findMissingUserIds(ownerIds.slice(i, i + batchSize))));
  }

  let artifacts = 0;
  let transferred = 0;
  for (const ownerId of orphans) {
    if (dryRun) {
      const transfers = await findTransferableOrgArtifacts(ownerId);
      const count = (await PublishedArtifact.countDocuments({ ownerId, deletedAt: null })) - transfers.length;
      artifacts += count;
      transferred += transfers.length;
      log(
        `[backfill-orphaned-published-artifacts] owner ${ownerId}: would remove ${count} artifact(s), ` +
          `would transfer ${transfers.length} org artifact(s)` +
          transfers.map(t => ` ${t.publicId}->${t.ownerId}`).join('')
      );
    } else {
      const result = await purgeOwnerPublishedArtifacts(ownerId, { deletedBy: ORPHAN_BACKFILL_DELETED_BY });
      artifacts += result.artifacts.length;
      transferred += result.transferred.length;
      log(
        `[backfill-orphaned-published-artifacts] owner ${ownerId}: removed ${result.artifacts.length} artifact(s), ` +
          `transferred ${result.transferred.length} org artifact(s)` +
          result.transferred.map(t => ` ${t.publicId}->${t.ownerId}`).join('') +
          `, annotations=${result.annotations} reports=${result.reports} viewAudits=${result.viewAudits}`
      );
    }
  }

  log(
    `[backfill-orphaned-published-artifacts] ${ownerIds.length} owner(s) with live artifacts; ` +
      `${orphans.length} orphaned; ${dryRun ? 'would remove' : 'removed'} ${artifacts} artifact(s), ` +
      `${dryRun ? 'would transfer' : 'transferred'} ${transferred} org artifact(s)`
  );

  const authorIds = (await Annotation.distinct<string>('authorId', { deletedAt: null })).map(String);
  const deletedAuthors: string[] = [];
  for (let i = 0; i < authorIds.length; i += batchSize) {
    deletedAuthors.push(...(await findMissingUserIds(authorIds.slice(i, i + batchSize))));
  }

  let annotations = 0;
  for (const authorId of deletedAuthors) {
    const count = dryRun
      ? await Annotation.countDocuments({ authorId, deletedAt: null })
      : await hideDeletedAuthorAnnotations(authorId);
    annotations += count;
    log(
      `[backfill-orphaned-published-artifacts] author ${authorId}: ${dryRun ? 'would hide' : 'hid'} ${count} annotation(s)`
    );
  }

  log(
    `[backfill-orphaned-published-artifacts] ${authorIds.length} author(s) with live annotations; ` +
      `${deletedAuthors.length} deleted; ${dryRun ? 'would hide' : 'hid'} ${annotations} annotation(s)`
  );
  return { orphanedOwners: orphans.length, artifacts, transferred, deletedAuthors: deletedAuthors.length, annotations };
}
