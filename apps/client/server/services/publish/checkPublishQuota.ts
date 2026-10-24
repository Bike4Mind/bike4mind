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
 * Aggregate-on-read: we sum `size.totalBytes` over active rows for the owner,
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
  /** Footprint of the publish being attempted. */
  incoming: { bytes: number; fileCount: number };
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

/** Sum active artifact bytes for a match filter, excluding one key. */
async function aggregateUsage(
  match: Record<string, unknown>,
  replacing?: { tier: PublishScopeTier; scopeId: string; slug: string } | null
): Promise<QuotaUsage> {
  const filter: Record<string, unknown> = { ...match, deletedAt: null };
  if (replacing) {
    // Exclude the row being overwritten so its bytes don't inflate usage.
    filter.$nor = [{ tier: replacing.tier, scopeId: replacing.scopeId, slug: replacing.slug }];
  }
  const [row] = await PublishedArtifact.aggregate<{ totalBytes: number }>([
    { $match: filter },
    { $group: { _id: null, totalBytes: { $sum: '$size.totalBytes' } } },
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
  incoming: { bytes: number; fileCount: number },
  caps: { maxTotalBytes: number }
): Extract<PublishQuotaResult, { ok: false }> | null {
  const projectedBytes = usage.totalBytes + incoming.bytes;
  if (projectedBytes > caps.maxTotalBytes) {
    return {
      ok: false,
      status: 413,
      code: 'quota_bytes_exceeded',
      error: `Publish storage quota reached: this publish (${fmtBytes(incoming.bytes)}) would exceed your ${scope} limit of ${fmtBytes(
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
  /** The live page being rewritten: its owner is charged, and its current size is the baseline. */
  artifact: {
    ownerId: string;
    tier: PublishScopeTier;
    scopeId: string;
    slug: string;
    size: { totalBytes: number };
  };
  /** The page's footprint once rewritten. */
  next: { bytes: number; fileCount: number };
}

/**
 * Quota for rewriting a live page's bundle in place (revise, restore), counting the net change:
 * the page's current bytes leave usage and its new total comes in, exactly as a same-slug
 * re-publish is counted. A rewrite that does not grow the page adds nothing, so it is allowed
 * even for an owner already over a cap (a restore to a smaller version only frees space).
 *
 * Only live pages' current bundles are counted, here as on every publish path: the prior
 * index.html each revise/restore/re-publish archives under `versions/` is not part of usage.
 */
export async function checkInPlaceRewriteQuota(input: InPlaceRewriteQuotaInput): Promise<PublishQuotaResult> {
  const { artifact, next } = input;
  if (next.bytes <= artifact.size.totalBytes) return { ok: true };
  return checkPublishQuota({
    ownerId: artifact.ownerId,
    orgScopeId: artifact.tier === 'organization' ? artifact.scopeId : null,
    isAdmin: input.isAdmin,
    incoming: next,
    replacing: { tier: artifact.tier, scopeId: artifact.scopeId, slug: artifact.slug },
  });
}
