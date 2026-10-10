import type { PublishScopeTier, PublishSourceKind, PublishVisibility } from '@bike4mind/common';
import type { Types } from 'mongoose';
import { Annotation } from './AnnotationModel';
import { PublishedArtifact } from './PublishedArtifactModel';
import { PublishedArtifactReport } from './PublishedArtifactReportModel';
import { PublishedArtifactViewAuditModel } from './PublishedArtifactViewAuditModel';

/** The fields a caller needs to purge the CDN for an artifact this run removed. */
export interface PurgedPublishedArtifact {
  publicId: string;
  tier: PublishScopeTier;
  scopeId: string;
  slug: string;
  visibility: PublishVisibility;
  source: { kind: PublishSourceKind };
}

export interface PurgeOwnerPublishedArtifactsResult {
  /** Artifacts that were live before this call and are now soft-deleted. */
  artifacts: PurgedPublishedArtifact[];
  annotations: number;
  reports: number;
  viewAudits: number;
}

/**
 * Remove everything a user has published, for when the account itself is going away.
 *
 * Soft-deletes every live PublishedArtifact owned by `ownerId` - every reader filters on
 * `deletedAt: null`, so their share tokens and `/p` URLs stop resolving at once - then
 * soft-deletes the annotations on them, resolves their open reports and drops their gated-view
 * audit rows (viewer IPs/user agents kept only for the owner's benefit).
 *
 * Idempotent: the child sweep covers ALL of the owner's artifacts, not just the ones this call
 * removed, so a re-run after a partial failure finishes the job and a clean re-run changes nothing.
 * Stored bundle objects in S3 are left in place; nothing serves them once the row is deleted.
 * CDN invalidation is the caller's job (see apps/client/server/services/publish/purgeUserPublishedArtifacts.ts).
 */
export async function purgeOwnerPublishedArtifacts(
  ownerId: string,
  { deletedBy }: { deletedBy: string }
): Promise<PurgeOwnerPublishedArtifactsResult> {
  const now = new Date();

  const live = await PublishedArtifact.find({ ownerId, deletedAt: null })
    .select('_id publicId tier scopeId slug visibility source.kind')
    .lean<(PurgedPublishedArtifact & { _id: Types.ObjectId })[]>();
  if (live.length > 0) {
    await PublishedArtifact.updateMany(
      { _id: { $in: live.map(a => a._id) }, deletedAt: null },
      { $set: { deletedAt: now, deletedBy } }
    );
  }

  const publicIds = await PublishedArtifact.distinct<string>('publicId', { ownerId });
  if (publicIds.length === 0) {
    return { artifacts: [], annotations: 0, reports: 0, viewAudits: 0 };
  }

  const [annotations, reports, viewAudits] = await Promise.all([
    Annotation.updateMany({ publicId: { $in: publicIds }, deletedAt: null }, { $set: { deletedAt: now, deletedBy } }),
    PublishedArtifactReport.updateMany(
      { publicId: { $in: publicIds }, status: 'open' },
      { $set: { status: 'actioned', resolvedBy: deletedBy, resolvedAt: now } }
    ),
    PublishedArtifactViewAuditModel.deleteMany({ publicId: { $in: publicIds } }),
  ]);

  return {
    artifacts: live.map(({ publicId, tier, scopeId, slug, visibility, source }) => ({
      publicId,
      tier,
      scopeId,
      slug,
      visibility,
      source: { kind: source.kind },
    })),
    annotations: annotations.modifiedCount,
    reports: reports.modifiedCount,
    viewAudits: viewAudits.deletedCount,
  };
}
