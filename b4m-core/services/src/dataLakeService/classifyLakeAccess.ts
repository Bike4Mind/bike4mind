import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';
import { normalizeId } from '@bike4mind/utils';
import { canManageLake, type LakeGrant } from './manageRule';

/**
 * Which of the legacy access ARMS decided a read. These are the five arms the read-time grant
 * cutover (#1673) diffs against - owner/admin bypass, public, private-by-default, org prerequisite,
 * requirement match. `requirement` is the tag/entitlement any-of: the EPHEMERAL membership arm,
 * resolved live from `ctx` on every request and never materialized into a stored row.
 */
export type LakeAccessArm =
  | 'owner-admin' // canManageLake bypass: platform admin, effective owner, curator, or org rung.
  | 'public' // isPublic lake - requirement still applies as defense in depth.
  | 'private-deny' // Private-by-default: no org, no gate -> owner/admin only, deny everyone else.
  | 'org-prereq' // Org-scoped lake, caller not a member of its org -> deny before the any-of.
  | 'requirement'; // Tag/entitlement any-of (the ephemeral membership arm).

export interface LakeAccessClassification {
  allowed: boolean;
  /** The arm that PRODUCED this decision (allow or deny), for the report-only cutover diff. */
  arm: LakeAccessArm;
}

/**
 * The legacy pure access decision, decomposed into the arm that produced it. This is exactly the
 * behavior of `canAccessLake` (which now delegates here) - extracted so the read-time grant cutover
 * can report WHICH arm decided without a second, drift-prone copy of the rule. Bypass-then-constraints:
 * owner/admin is granted immediately; otherwise a non-owner must satisfy the org constraint (if the
 * lake is org-scoped) AND the requirement any-of. Org stays a HARD prerequisite, never folded into
 * the any-of, so a tag/entitlement holder in a different org is still denied (the "widening" trap the
 * epic names). Private-by-default runs BEFORE the any-of, whose no-requirement case would otherwise
 * read as public.
 *
 * Pure/sync/testable: `grants` is the lake's pre-fetched ACTIVE grant set, same seam as `canManageLake`.
 */
export function classifyLakeAccess(
  lake: Pick<
    IDataLakeDocument,
    'createdByUserId' | 'organizationId' | 'requiredUserTag' | 'requiredEntitlement' | 'isPublic'
  >,
  ctx: AccessContext,
  grants: readonly LakeGrant[] = []
): LakeAccessClassification {
  if (canManageLake(lake, ctx, grants)) return { allowed: true, arm: 'owner-admin' };

  const normalizedTags = ctx.userTags.map(t => t.toLowerCase());
  const normalizedKeys = (ctx.entitlementKeys ?? []).map(normalizeEntitlementKey);

  // Public: readable app-wide - bypasses BOTH the org prerequisite and Private-by-default. The gate
  // is STILL respected via lakeMatchesAccess (defense in depth: a gate added after publishing keeps
  // holding), but a normal public lake is gate-less so this allows everyone.
  if (lake.isPublic) return { allowed: lakeMatchesAccess(lake, normalizedTags, normalizedKeys), arm: 'public' };

  // Normalize the lake's org id ONCE so "does this lake have an org" (private-by-default) and "does
  // the org match" (org prerequisite) agree on the same value - a divergence would let a truthy-but-
  // not-id-shaped org skip both denies and fall through to lakeMatchesAccess as world-readable.
  const lakeOrgId = normalizeId(lake.organizationId);

  // Private (no org, no gate) -> owner/admin only. Must run before the any-of, which treats a
  // no-requirement lake as public.
  if (!lakeOrgId && !lake.requiredUserTag && !lake.requiredEntitlement) return { allowed: false, arm: 'private-deny' };

  // Org is a hard prerequisite when the lake is org-scoped - evaluated BEFORE the any-of so a
  // non-member can never pass. `?? []`: a malformed ctx must deny, not throw or vacuously allow.
  if (lakeOrgId && !(ctx.organizationIds ?? []).includes(lakeOrgId)) return { allowed: false, arm: 'org-prereq' };

  return { allowed: lakeMatchesAccess(lake, normalizedTags, normalizedKeys), arm: 'requirement' };
}
