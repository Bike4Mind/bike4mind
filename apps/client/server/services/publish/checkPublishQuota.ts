import { PublishedArtifact } from '@bike4mind/database';
import { PUBLISH_QUOTAS, type PublishScopeTier } from '@bike4mind/common';

/**
 * Publish - cumulative per-owner quota enforcement.
 *
 * Distinct from the per-bundle `PUBLISH_LIMITS` (which bound a single publish),
 * this caps how much a user - and an organization scope - may host in
 * aggregate, bounding storage cost and the abuse/phishing-hosting surface.
 *
 * Aggregate-on-read: we sum `size.totalBytes` and count active rows for the
 * owner, exclude the artifact being overwritten (a re-publish replaces bytes,
 * it does not add them), then check that the incoming publish still fits. See
 * the overshoot caveat on `PUBLISH_QUOTAS`.
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
  count: number;
  totalBytes: number;
}

export type PublishQuotaResult =
  | { ok: true }
  | {
      ok: false;
      status: 413;
      code: 'quota_artifacts_exceeded' | 'quota_bytes_exceeded';
      error: string;
      details: { scope: 'user' | 'org'; limit: number; current: number; attempted: number };
    };

/** Sum active artifact bytes + count for a match filter, excluding one key. */
async function aggregateUsage(
  match: Record<string, unknown>,
  replacing?: { tier: PublishScopeTier; scopeId: string; slug: string } | null
): Promise<QuotaUsage> {
  const filter: Record<string, unknown> = { ...match, deletedAt: null };
  if (replacing) {
    // Exclude the row being overwritten so its bytes/count don't inflate usage.
    filter.$nor = [{ tier: replacing.tier, scopeId: replacing.scopeId, slug: replacing.slug }];
  }
  const [row] = await PublishedArtifact.aggregate<{ totalBytes: number; count: number }>([
    { $match: filter },
    { $group: { _id: null, totalBytes: { $sum: '$size.totalBytes' }, count: { $sum: 1 } } },
  ]);
  return { totalBytes: row?.totalBytes ?? 0, count: row?.count ?? 0 };
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
  caps: { maxArtifacts: number; maxTotalBytes: number }
): Extract<PublishQuotaResult, { ok: false }> | null {
  // A re-publish (replacing) keeps the row count flat; only genuinely new rows
  // add to the count. `usage` already excludes the replaced row, so adding 1
  // here is correct whether or not this is an overwrite.
  const projectedCount = usage.count + 1;
  if (projectedCount > caps.maxArtifacts) {
    return {
      ok: false,
      status: 413,
      code: 'quota_artifacts_exceeded',
      error: `Publish quota reached: your ${scope} scope already hosts ${usage.count} of ${caps.maxArtifacts} allowed published pages. Delete an existing page to publish a new one.`,
      details: { scope, limit: caps.maxArtifacts, current: usage.count, attempted: projectedCount },
    };
  }
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
