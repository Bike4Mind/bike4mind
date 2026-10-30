import { PublishedArtifact } from '@bike4mind/database';
import { PUBLISH_QUOTAS, type PublishScopeTier } from '@bike4mind/common';

/**
 * Publish - cumulative per-owner quota enforcement.
 *
 * Distinct from the per-bundle `PUBLISH_LIMITS` (which bound a single publish),
 * this caps how much a user - and an organization scope - may host in
 * aggregate, bounding storage cost. There is no page-count cap; abuse is
 * handled per page by report and takedown.
 *
 * Aggregate-on-read: we sum each active row's footprint for the owner - its
 * `size.totalBytes` plus its archived versions (see `archivedVersionBytes`) -
 * exclude the artifact being overwritten (a re-publish replaces bytes, it does
 * not add them), then check that the incoming publish still fits. See the
 * overshoot caveat on `PUBLISH_QUOTAS`.
 *
 * Admins bypass quota, mirroring `checkScopePermission`.
 *
 * Returns `{ ok: true }` or `{ ok: false, status, error, code, details }` which
 * the route maps straight to an HTTP response (413 Payload Too Large - the
 * closest standard status for "you've used your allowance").
 */

export interface PublishQuotaInput {
  /** Owner of the artifact (the publishing user) - drives the user-quota ladder. */
  ownerId: string;
  /** Org id when publishing into an organization scope - drives the org ladder. */
  orgScopeId?: string | null;
  isAdmin?: boolean;
  /**
   * Footprint of the publish being attempted. `archivedBytes` is what the page's archived versions
   * will occupy once it lands (`archivedVersionBytes` over its history after this publish): they
   * are counted here because `replacing` takes the whole row, archived versions included, out of usage.
   */
  incoming: { bytes: number; fileCount: number; archivedBytes?: number };
  /**
   * The artifact this publish overwrites in place, if any. Its current
   * footprint is excluded from usage so a same-key re-publish isn't double
   * counted. Identified by the compound key.
   */
  replacing?: { tier: PublishScopeTier; scopeId: string; slug: string } | null;
}

export interface QuotaUsage {
  totalBytes: number;
}

export type PublishQuotaResult =
  | { ok: true }
  | {
      ok: false;
      status: 413;
      code: 'quota_bytes_exceeded';
      error: string;
      details: { scope: 'user' | 'org'; limit: number; current: number; attempted: number };
    };

/** A version-history entry, as far as storage is concerned. */
export interface VersionBytes {
  sha256Index: string;
  indexBytes?: number;
}

/**
 * Bytes a page's archived versions occupy: the `indexBytes` of every history entry except the
 * current one, whose bytes are the live index.html already counted in `size.totalBytes`.
 * Without `currentSha` (rows older than the field) the latest entry is current, as in the serve
 * route. Each sha counts once, at its largest `indexBytes`: the archive is one blob per sha
 * (`versions/{sha}.html`), and concurrent finalizes can record a sha twice (see the serve route's
 * read-time dedupe). Must stay in sync with `aggregateUsage`, the same sum inside the aggregation.
 */
export function archivedVersionBytes(
  versions: readonly VersionBytes[] | undefined,
  currentSha: string | undefined
): number {
  const list = versions ?? [];
  const current = currentSha ?? list[list.length - 1]?.sha256Index;
  const bySha = new Map<string, number>();
  for (const v of list) {
    if (v.sha256Index === current) continue;
    // Entries recorded before indexBytes was tracked count 0, so no owner is pushed over a cap retroactively.
    bySha.set(v.sha256Index, Math.max(bySha.get(v.sha256Index) ?? 0, v.indexBytes ?? 0));
  }
  let total = 0;
  for (const bytes of bySha.values()) total += bytes;
  return total;
}

/** Sum active artifact footprints (bundle plus archived versions) for a match filter, excluding one key. */
async function aggregateUsage(
  match: Record<string, unknown>,
  replacing?: { tier: PublishScopeTier; scopeId: string; slug: string } | null
): Promise<QuotaUsage> {
  const filter: Record<string, unknown> = { ...match, deletedAt: null };
  if (replacing) {
    // Exclude the row being overwritten so its bytes don't inflate usage.
    filter.$nor = [{ tier: replacing.tier, scopeId: replacing.scopeId, slug: replacing.slug }];
  }
  // archivedVersionBytes per row, as group stages so a long history stays linear: one document per
  // (page, version sha), then per page, then the total. A page with no history unwinds to one document.
  const [row] = await PublishedArtifact.aggregate<{ totalBytes: number }>([
    { $match: filter },
    {
      $project: {
        bundleBytes: { $ifNull: ['$size.totalBytes', 0] },
        currentSha: { $ifNull: ['$sha256Index', { $arrayElemAt: ['$versions.sha256Index', -1] }] },
        versions: { $ifNull: ['$versions', []] },
      },
    },
    { $unwind: { path: '$versions', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: { page: '$_id', sha: '$versions.sha256Index' },
        bundleBytes: { $first: '$bundleBytes' },
        archivedBytes: {
          $max: {
            $cond: [{ $eq: ['$versions.sha256Index', '$currentSha'] }, 0, { $ifNull: ['$versions.indexBytes', 0] }],
          },
        },
      },
    },
    {
      $group: { _id: '$_id.page', bundleBytes: { $first: '$bundleBytes' }, archivedBytes: { $sum: '$archivedBytes' } },
    },
    { $group: { _id: null, totalBytes: { $sum: { $add: ['$bundleBytes', '$archivedBytes'] } } } },
  ]);
  return { totalBytes: row?.totalBytes ?? 0 };
}

function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

/** Check one ladder; returns a failure result or null if it fits. */
function evaluate(
  scope: 'user' | 'org',
  usage: QuotaUsage,
  incoming: PublishQuotaInput['incoming'],
  caps: { maxTotalBytes: number }
): Extract<PublishQuotaResult, { ok: false }> | null {
  const archivedBytes = incoming.archivedBytes ?? 0;
  const pageBytes = incoming.bytes + archivedBytes;
  const projectedBytes = usage.totalBytes + pageBytes;
  if (projectedBytes > caps.maxTotalBytes) {
    const versionsNote = archivedBytes > 0 ? ' including its earlier versions' : '';
    return {
      ok: false,
      status: 413,
      code: 'quota_bytes_exceeded',
      error: `Publish storage quota reached: this publish (${fmtBytes(pageBytes)}${versionsNote}) would exceed your ${scope} limit of ${fmtBytes(
        caps.maxTotalBytes
      )} (${fmtBytes(usage.totalBytes)} already used). Delete an existing page to free space.`,
      details: { scope, limit: caps.maxTotalBytes, current: usage.totalBytes, attempted: projectedBytes },
    };
  }
  return null;
}

export async function checkPublishQuota(input: PublishQuotaInput): Promise<PublishQuotaResult> {
  const { ownerId, orgScopeId, isAdmin, incoming, replacing } = input;

  if (isAdmin) {
    return { ok: true }; // admins bypass quota, mirroring checkScopePermission
  }

  // User ladder: everything this owner hosts, across all scopes.
  const userUsage = await aggregateUsage({ ownerId }, replacing);
  const userFail = evaluate('user', userUsage, incoming, PUBLISH_QUOTAS.user);
  if (userFail) return userFail;

  // Org ladder: only when publishing into an org scope.
  if (orgScopeId) {
    const orgUsage = await aggregateUsage({ tier: 'organization', scopeId: orgScopeId }, replacing);
    const orgFail = evaluate('org', orgUsage, incoming, PUBLISH_QUOTAS.org);
    if (orgFail) return orgFail;
  }

  return { ok: true };
}

export interface InPlaceRewriteQuotaInput {
  isAdmin?: boolean;
  /** The live page being rewritten: its owner is charged, and its current footprint is the baseline. */
  artifact: {
    ownerId: string;
    tier: PublishScopeTier;
    scopeId: string;
    slug: string;
    size: { totalBytes: number };
    sha256Index?: string;
    versions?: readonly VersionBytes[];
  };
  /** The page once rewritten: its bundle, its new current version and its whole version history. */
  next: { bytes: number; fileCount: number; sha256Index: string; versions: readonly VersionBytes[] };
}

/**
 * Quota for rewriting a live page in place (revise, restore), counting the net change in its
 * footprint, exactly as a same-slug re-publish is counted: the bundle plus the archived versions.
 * Replacing the current version archives its index.html, so a rewrite to new content grows the
 * page by the new index.html even when the bundle does not grow. A rewrite that does not grow the
 * footprint (unchanged content, or a restore that only swaps which archived version is current)
 * is allowed even for an owner already over a cap.
 */
export async function checkInPlaceRewriteQuota(input: InPlaceRewriteQuotaInput): Promise<PublishQuotaResult> {
  const { artifact, next } = input;
  const nextArchivedBytes = archivedVersionBytes(next.versions, next.sha256Index);
  const currentFootprint = artifact.size.totalBytes + archivedVersionBytes(artifact.versions, artifact.sha256Index);
  if (next.bytes + nextArchivedBytes <= currentFootprint) return { ok: true };
  return checkPublishQuota({
    ownerId: artifact.ownerId,
    orgScopeId: artifact.tier === 'organization' ? artifact.scopeId : null,
    isAdmin: input.isAdmin,
    incoming: { bytes: next.bytes, fileCount: next.fileCount, archivedBytes: nextArchivedBytes },
    replacing: { tier: artifact.tier, scopeId: artifact.scopeId, slug: artifact.slug },
  });
}
