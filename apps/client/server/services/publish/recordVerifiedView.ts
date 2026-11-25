import { PublishedArtifact } from '@bike4mind/database';
import { hasQualifyingSocialParty } from '@server/services/gears/socialParty';

/**
 * Call only after admitting the viewer to the page. The viewer must pass hasQualifyingSocialParty
 * for the owner; pass `qualified` when the caller has already run that check for this viewer.
 */
export async function recordVerifiedView(
  artifact: { publicId: string; ownerId: string; verifiedExternalViewCount?: number },
  viewerId?: string,
  qualified?: boolean
): Promise<void> {
  if ((artifact.verifiedExternalViewCount ?? 0) > 0) return;
  if (!viewerId || String(viewerId) === String(artifact.ownerId)) return;
  if (!(qualified ?? (await hasQualifyingSocialParty(String(artifact.ownerId), [String(viewerId)])))) return;
  await PublishedArtifact.updateOne(
    { publicId: artifact.publicId, ownerId: artifact.ownerId, deletedAt: null },
    { $inc: { verifiedExternalViewCount: 1 } },
    { runValidators: true }
  );
}
