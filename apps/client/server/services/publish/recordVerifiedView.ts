import { PublishedArtifact, User } from '@bike4mind/database';

/** Call only after admitting the viewer to the page. Verification is read from the account. */
export async function recordVerifiedView(
  artifact: { publicId: string; ownerId: string; verifiedExternalViewCount?: number },
  viewerId?: string
): Promise<void> {
  if ((artifact.verifiedExternalViewCount ?? 0) > 0) return;
  if (!viewerId || String(viewerId) === String(artifact.ownerId)) return;
  if (!(await User.exists({ _id: viewerId, emailVerified: true, deletedAt: null }))) return;
  await PublishedArtifact.updateOne(
    { publicId: artifact.publicId, ownerId: artifact.ownerId, deletedAt: null },
    { $inc: { verifiedExternalViewCount: 1 } },
    { runValidators: true }
  );
}
