import type { PublishVisibility } from '@bike4mind/common';
import type { PublishUser } from './checkScopePermission';

/**
 * Publish - shared visibility gate for a PublishedArtifact. Extracted from the
 * serve handler so the public viewer AND the annotation routes reason about
 * "may this caller VIEW this artifact" through one code path.
 *
 * Mirrors the visibility ladder { private, project, organization, public }:
 *  - public          -> anyone, even anonymous
 *  - organization     -> same-org members (org tier stores org _id as scopeId)
 *  - project          -> project owner or member
 *  - private          -> owner / admin only
 *
 * Returns `{ ok: true }` or `{ ok: false, status, error }` for direct mapping to
 * an HTTP response. `user` is undefined for anonymous callers.
 */

/** The minimal artifact shape the gate needs. */
export interface VisibilityCheckArtifact {
  visibility: PublishVisibility;
  ownerId: string;
  scopeId: string;
}

export type VisibilityResult = { ok: true } | { ok: false; status: 401 | 403; error: string };

export async function checkVisibility(
  artifact: VisibilityCheckArtifact,
  user: PublishUser | undefined
): Promise<VisibilityResult> {
  if (artifact.visibility === 'public') return { ok: true };
  if (!user?.id) return { ok: false, status: 401, error: 'Authentication required' };
  if (user.isAdmin) return { ok: true };
  if (artifact.ownerId === String(user.id)) return { ok: true };

  if (artifact.visibility === 'organization') {
    // org-tier artifacts store the org _id as scopeId.
    if (user.organizationId && String(artifact.scopeId) === String(user.organizationId)) return { ok: true };
    return { ok: false, status: 403, error: 'Not authorized for this organization' };
  }
  if (artifact.visibility === 'project') {
    const { Project } = await import('@bike4mind/database');
    const member = await Project.findOne({
      _id: artifact.scopeId,
      $or: [{ userId: String(user.id) }, { 'users.id': String(user.id) }],
    })
      .select('_id')
      .lean<{ _id: unknown } | null>();
    if (member) return { ok: true };
    return { ok: false, status: 403, error: 'Not authorized for this project' };
  }
  // private (and any other non-public level) -> owner/admin only, already checked.
  return { ok: false, status: 403, error: 'Not authorized' };
}
