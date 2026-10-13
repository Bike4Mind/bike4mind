import type { PublishScopeTier, PublishSourceKind, PublishVisibility } from '@bike4mind/common';
import { Types } from 'mongoose';
import { User } from '../auth/UserModel';
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

/** An org-tier artifact handed to `ownerId`, its last publisher, instead of being removed. */
export interface TransferredPublishedArtifact extends PurgedPublishedArtifact {
  ownerId: string;
}

export interface PurgeOwnerPublishedArtifactsResult {
  /** Artifacts that were live before this call and are now soft-deleted. */
  artifacts: PurgedPublishedArtifact[];
  /** Org-tier artifacts that stay live under their last publisher. */
  transferred: TransferredPublishedArtifact[];
  annotations: number;
  reports: number;
  viewAudits: number;
}

const OBJECT_ID_HEX = /^[a-f0-9]{24}$/i;

/** The subset of `ids` with no row in the users collection. A non-ObjectId id can never match one. */
export async function findMissingUserIds(ids: string[]): Promise<string[]> {
  const valid = ids.filter(id => OBJECT_ID_HEX.test(id));
  const existing = await User.collection
    .find({ _id: { $in: valid.map(id => new Types.ObjectId(id)) } }, { projection: { _id: 1 } })
    .toArray();
  const found = new Set(existing.map(u => String(u._id)));
  return ids.filter(id => !found.has(id));
}

/**
 * The live org-tier artifacts of `ownerId` that a teammate revised last and that should outlive
 * the owner's account: a revise keeps the original ownerId and only moves `lastPublishedBy`
 * (apps/client/pages/api/publish/artifact/finalize.ts), so without this the org's page would go
 * down with whoever first published it. Only a last publisher that still exists AND is still a
 * member of the artifact's organization qualifies: `ownerId` grants full management of the page
 * (visibility, share links, delete) with no further membership check, so handing it to someone
 * who has since left the org would give an outsider control of the org's page.
 */
export async function findTransferableOrgArtifacts(ownerId: string): Promise<TransferredPublishedArtifact[]> {
  const candidates = await PublishedArtifact.find({
    ownerId,
    tier: 'organization',
    deletedAt: null,
    lastPublishedBy: { $nin: [null, ownerId] },
  })
    .select('publicId tier scopeId slug visibility source.kind lastPublishedBy')
    .lean<(PurgedPublishedArtifact & { lastPublishedBy: string })[]>();
  if (candidates.length === 0) return [];

  const publisherIds = [...new Set(candidates.map(a => a.lastPublishedBy))].filter(id => OBJECT_ID_HEX.test(id));
  const publishers = await User.collection
    .find(
      { _id: { $in: publisherIds.map(id => new Types.ObjectId(id)) } },
      { projection: { _id: 1, organizationId: 1 } }
    )
    .toArray();
  const orgOf = new Map(publishers.map(u => [String(u._id), u.organizationId ? String(u.organizationId) : null]));
  return candidates
    .filter(a => orgOf.get(a.lastPublishedBy) === String(a.scopeId))
    .map(({ publicId, tier, scopeId, slug, visibility, source, lastPublishedBy }) => ({
      publicId,
      tier,
      scopeId,
      slug,
      visibility,
      source: { kind: source.kind },
      ownerId: lastPublishedBy,
    }));
}

/**
 * Remove everything a user has published, for when the account itself is going away.
 *
 * First hands each org-tier artifact a different, still-existing user published last over to
 * that user (see findTransferableOrgArtifacts); those stay live with their annotations, reports
 * and audits. Then soft-deletes the annotations on every PublishedArtifact owned by `ownerId`, resolves their open
 * reports and drops their gated-view audit rows (viewer IPs/user agents kept only for the owner's
 * benefit), then soft-deletes the live artifacts themselves - every reader filters on
 * `deletedAt: null`, so their share tokens and `/p` URLs stop resolving at once.
 *
 * Children go first so a failure leaves the artifacts live: the orphan backfill
 * (packages/scripts/src/backfillOrphanedPublishedArtifacts.ts) only finds owners with live
 * artifacts, so that is what lets it re-run this and finish the job. Idempotent: the child sweep
 * covers ALL of the owner's artifacts, and a clean re-run changes nothing.
 * Stored bundle objects in S3 are left in place; nothing serves them once the row is deleted.
 * CDN invalidation is the caller's job (see apps/client/server/services/publish/purgeUserPublishedArtifacts.ts).
 */
export async function purgeOwnerPublishedArtifacts(
  ownerId: string,
  { deletedBy }: { deletedBy: string }
): Promise<PurgeOwnerPublishedArtifactsResult> {
  const now = new Date();

  const transferred = await findTransferableOrgArtifacts(ownerId);
  for (const artifact of transferred) {
    await PublishedArtifact.updateOne(
      { publicId: artifact.publicId, ownerId, deletedAt: null },
      { $set: { ownerId: artifact.ownerId } }
    );
  }

  const publicIds = await PublishedArtifact.distinct<string>('publicId', { ownerId });
  if (publicIds.length === 0) {
    return { artifacts: [], transferred, annotations: 0, reports: 0, viewAudits: 0 };
  }

  const [annotations, reports, viewAudits] = await Promise.all([
    Annotation.updateMany({ publicId: { $in: publicIds }, deletedAt: null }, { $set: { deletedAt: now, deletedBy } }),
    PublishedArtifactReport.updateMany(
      { publicId: { $in: publicIds }, status: 'open' },
      { $set: { status: 'actioned', resolvedBy: deletedBy, resolvedAt: now } }
    ),
    PublishedArtifactViewAuditModel.deleteMany({ publicId: { $in: publicIds } }),
  ]);

  const live = await PublishedArtifact.find({ ownerId, deletedAt: null })
    .select('_id publicId tier scopeId slug visibility source.kind')
    .lean<(PurgedPublishedArtifact & { _id: Types.ObjectId })[]>();
  if (live.length > 0) {
    await PublishedArtifact.updateMany(
      { _id: { $in: live.map(a => a._id) }, deletedAt: null },
      { $set: { deletedAt: now, deletedBy } }
    );
  }

  return {
    artifacts: live.map(({ publicId, tier, scopeId, slug, visibility, source }) => ({
      publicId,
      tier,
      scopeId,
      slug,
      visibility,
      source: { kind: source.kind },
    })),
    transferred,
    annotations: annotations.modifiedCount,
    reports: reports.modifiedCount,
    viewAudits: viewAudits.deletedCount,
  };
}
