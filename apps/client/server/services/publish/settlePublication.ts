import { randomUUID } from 'node:crypto';
import { PublishedArtifact } from '@bike4mind/database';
import type { PublishScopeTier, PublishVisibility } from '@bike4mind/common';
import { checkPublishQuota } from './checkPublishQuota';
import { invalidatePublishCdn, toCacheTarget } from './invalidatePublishCdn';
import { restrictDuplicatePublications } from './restrictDuplicatePublications';

interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export type SettleSource =
  { kind: 'reply'; sessionId: string; messageId: string } | { kind: 'fabfile'; fabFileId: string };

export interface SettlePublicationInput {
  ownerId: string;
  isAdmin?: boolean;
  source: SettleSource;
  tier: PublishScopeTier;
  scopeId: string;
  /** Already validated against the tier (resolveVisibility). */
  visibility: PublishVisibility;
  title: string;
  renderedBody: string;
  /** Extra source-specific fields written alongside the snapshot (e.g. reply citables). */
  extraSet?: Record<string, unknown>;
  logger: MinimalLogger;
}

const SLUG_PREFIX: Record<SettleSource['kind'], string> = { reply: 'r', fabfile: 'f' };

function newPublicId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * Write a reply or file publication, shared by pages/api/publish/reply.ts and fabfile.ts.
 * One record per owner+source, whatever scope it was first published into: a re-publish
 * (a Team <-> Private switch included) rewrites that record in place, so the /p/r or /p/f link
 * the owner already handed out is the one the new scope and visibility apply to. Owner-keyed, so
 * an admin publishing someone else's source never rewrites the owner's record. Afterwards purges
 * the CDN when a cached public copy can exist and narrows older duplicates
 * (restrictDuplicatePublications). Returns the saved record, or the status + body to answer with.
 */
export async function settlePublication(input: SettlePublicationInput) {
  const { ownerId, source, tier, scopeId, visibility, renderedBody } = input;
  const sourceKey = Object.fromEntries(
    Object.entries(source)
      .filter(([k]) => k !== 'kind')
      .map(([k, v]) => [`source.${k}`, v])
  );
  const existing = await PublishedArtifact.findOne({
    ownerId,
    'source.kind': source.kind,
    ...sourceKey,
    deletedAt: null,
  })
    .sort({ publishedAt: -1 })
    .lean<{
      _id: unknown;
      publicId: string;
      slug: string;
      tier: PublishScopeTier;
      scopeId: string;
      visibility: PublishVisibility;
    } | null>();

  const publicId = existing?.publicId ?? newPublicId();
  const slug = existing?.slug ?? `${SLUG_PREFIX[source.kind]}-${publicId}`;
  const bytes = Buffer.byteLength(renderedBody);

  // The in-place rewrite frees the row's OLD tier/scope/slug, so that is the key quota excludes.
  const quota = await checkPublishQuota({
    ownerId,
    orgScopeId: tier === 'organization' ? scopeId : null,
    isAdmin: input.isAdmin,
    incoming: { bytes, fileCount: 0 },
    replacing: existing ? { tier: existing.tier, scopeId: existing.scopeId, slug } : null,
  });
  if (!quota.ok) {
    return {
      ok: false as const,
      status: quota.status,
      body: { error: quota.error, code: quota.code, details: quota.details },
    };
  }

  const publishedAt = new Date();
  const saved = await PublishedArtifact.findOneAndUpdate(
    existing ? { _id: existing._id, ownerId, deletedAt: null } : { tier, scopeId, slug, deletedAt: null },
    {
      $set: {
        publicId,
        tier,
        scopeId,
        title: input.title,
        visibility,
        lastPublishedBy: ownerId,
        source,
        storageKeyPrefix: '',
        size: { totalBytes: bytes, fileCount: 0 },
        manifest: [],
        renderedBody,
        ...input.extraSet,
        publishedAt,
      },
      $setOnInsert: { ownerId },
    },
    // Upsert only for a first publish. If `existing` was deleted after the lookup, an upsert would
    // try to re-insert its _id over the soft-deleted row and fail with a duplicate key.
    { upsert: !existing, new: true }
  );
  if (!saved) {
    return {
      ok: false as const,
      status: 409,
      body: { error: 'This page was removed while it was being updated. Please try again.' },
    };
  }

  // The serve route lets a CDN cache open-public pages under this publicId. A first publish has a
  // fresh publicId with nothing cached; a re-publish that was or is public must purge, or a
  // downgrade keeps serving the cached public copy (and an upgrade the stale body) until its TTL.
  if (existing && (existing.visibility === 'public' || saved.visibility === 'public')) {
    await invalidatePublishCdn(toCacheTarget(saved), input.logger);
  }
  // Records minted before one-per-owner+source can still be serving this source; narrow them too.
  await restrictDuplicatePublications(saved, input.logger);

  return { ok: true as const, saved, slug, publishedAt };
}
