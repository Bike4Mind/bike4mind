import { PublishedArtifact } from '@bike4mind/database';
import {
  VISIBILITY_ORDER,
  type PublishScopeTier,
  type PublishSourceKind,
  type PublishVisibility,
} from '@bike4mind/common';
import { invalidatePublishCdn, toCacheTarget } from './invalidatePublishCdn';

interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface DuplicateKeeper {
  _id: unknown;
  ownerId: string;
  visibility: PublishVisibility;
  source: { kind: PublishSourceKind; messageId?: string | null; fabFileId?: string | null };
}

/**
 * Carry a downgrade over to the owner's OTHER live publications of the same reply or file.
 * Replies and files are one record per owner+source (reply.ts / fabfile.ts), but before that
 * rule a re-publish into another scope minted a second record, so a Private pick on the record
 * the dialog shows must not leave an older copy serving. Only ever narrows: a sibling ranked
 * above `keep` in VISIBILITY_ORDER (so a project keeper also narrows organization siblings) is set
 * to private - the one rung every tier allows
 * (SCOPE_POLICY) - and, if it was public, purged from the CDN. Bundles
 * are skipped - several publications of one notebook artifact are legitimate there.
 * Returns how many siblings were changed. Never throws on the purge (invalidatePublishCdn).
 */
export async function restrictDuplicatePublications(keep: DuplicateKeeper, logger?: MinimalLogger): Promise<number> {
  const moreOpen = VISIBILITY_ORDER.slice(VISIBILITY_ORDER.indexOf(keep.visibility) + 1);
  if (moreOpen.length === 0) return 0;
  const key =
    keep.source.kind === 'reply' && keep.source.messageId
      ? { 'source.messageId': keep.source.messageId }
      : keep.source.kind === 'fabfile' && keep.source.fabFileId
        ? { 'source.fabFileId': keep.source.fabFileId }
        : null;
  if (!key) return 0;

  const siblings = await PublishedArtifact.find({
    _id: { $ne: keep._id },
    ownerId: keep.ownerId,
    'source.kind': keep.source.kind,
    ...key,
    deletedAt: null,
    visibility: { $in: moreOpen },
  })
    .select('_id publicId tier scopeId slug source visibility')
    .lean<
      Array<{
        _id: unknown;
        publicId: string;
        tier: PublishScopeTier;
        scopeId: string;
        slug: string;
        source: { kind: PublishSourceKind };
        visibility: PublishVisibility;
      }>
    >();
  if (siblings.length === 0) return 0;

  await PublishedArtifact.updateMany(
    { _id: { $in: siblings.map(s => s._id) }, ownerId: keep.ownerId, deletedAt: null },
    { $set: { visibility: 'private', discoverable: false } }
  );
  // Awaited, not fire-and-forget: a Lambda can freeze before a dangling promise sends.
  for (const sibling of siblings) {
    if (sibling.visibility === 'public') await invalidatePublishCdn(toCacheTarget(sibling), logger);
  }
  logger?.info(`[PUBLISH] restricted ${siblings.length} duplicate publication(s) of ${keep.source.kind}`);
  return siblings.length;
}
