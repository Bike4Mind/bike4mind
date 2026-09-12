import type { PublishVisibility } from '@bike4mind/common';

/**
 * Publish - list-endpoint visibility filter. Pure. Builds the Mongo clause that
 * `GET /api/publish/artifacts` $and-merges onto any user query. Ported from
 * Polaris buildListFilter via the artifact-publishing blueprint and adapted to
 * B4M's visibility ladder (private -> project -> organization -> public).
 *
 * Non-admin can see an artifact when it isn't soft-deleted AND:
 *   (a) ownerId === user.id        - your own, regardless of visibility or gate
 *   (b) visibility === 'public'    - anyone, UNLESS it carries an accessGate
 *   (c) visibility === 'organization' AND it belongs to your org
 *   (d) visibility === 'project'   AND it belongs to one of your projects
 * Admins see everything (null filter = no restriction).
 *
 * The gate exclusion in (b) mirrors GET /api/publish/artifacts/[id], which 404s a gated
 * public artifact for a non-manager. Without it the list handed out the title, tags and
 * URL-constituent fields of passphrase/domain-gated artifacts to any caller - the gate held
 * on the serve path, but the list told you exactly what was behind it.
 */
export interface BuildListFilterInput {
  userId: string;
  isAdmin: boolean;
  /** The user's organization id (Organization._id as string), if any. */
  userOrganizationId?: string | null;
  /** Project ids the user can access, if resolved. */
  userProjectIds?: string[];
}

export function buildListVisibilityFilter(input: BuildListFilterInput): { $or: Array<Record<string, unknown>> } | null {
  if (input.isAdmin) return null;

  const clauses: Array<Record<string, unknown>> = [
    { ownerId: input.userId },
    // `accessGate: null` matches both an absent field and an explicit null, so only
    // genuinely ungated public artifacts list to non-owners.
    { visibility: 'public' satisfies PublishVisibility, accessGate: null },
  ];

  if (input.userOrganizationId) {
    // Organization-visible artifacts published under the user's org scope.
    clauses.push({
      visibility: 'organization' satisfies PublishVisibility,
      tier: 'organization',
      scopeId: input.userOrganizationId,
    });
  }

  if (input.userProjectIds && input.userProjectIds.length > 0) {
    clauses.push({
      visibility: 'project' satisfies PublishVisibility,
      tier: 'project',
      scopeId: { $in: input.userProjectIds },
    });
  }

  return { $or: clauses };
}
