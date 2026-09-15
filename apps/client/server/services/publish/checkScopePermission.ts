import type { PublishScopeTier } from '@bike4mind/common';

/**
 * Publish - per-scope publish permission check. Ported from Polaris
 * checkScopePermission via the artifact-publishing blueprint. B4M has no
 * feature-flag system (it uses CASL abilities), so this is the simpler
 * "authenticated + owns-the-scope" form: any authenticated user may publish to
 * their own user scope; org/project scopes require membership (or admin).
 *
 * Returns `{ ok: true }` or `{ ok: false, status, error }` which the route maps
 * straight to an HTTP response.
 */

export interface PublishUser {
  id: string;
  username?: string;
  isAdmin?: boolean;
  organizationId?: string | null;
}

export interface ScopePermissionInput {
  user: PublishUser;
  tier: PublishScopeTier;
  scopeId: string;
}

export type ScopePermissionResult = { ok: true } | { ok: false; status: 401 | 403 | 404; error: string };

export async function checkScopePermission(input: ScopePermissionInput): Promise<ScopePermissionResult> {
  const { user, tier, scopeId } = input;

  if (!user?.id) {
    return { ok: false, status: 401, error: 'Authenticated user required' };
  }
  if (user.isAdmin) {
    return { ok: true }; // admins may publish to any scope
  }

  if (tier === 'user') {
    // Own user scope only. scopeId may be the caller's id OR their username.
    if (scopeId === String(user.id) || (user.username && scopeId === user.username)) {
      return { ok: true };
    }
    return { ok: false, status: 403, error: 'You can only publish to your own user scope' };
  }

  if (tier === 'organization') {
    if (!user.organizationId) {
      return { ok: false, status: 403, error: 'You are not a member of any organization' };
    }
    // scopeId is the Organization._id (string) for org-scope artifacts.
    const { Organization } = await import('@bike4mind/database');
    const org = await Organization.findById(scopeId).select('_id').lean<{ _id: unknown }>();
    if (!org) {
      return { ok: false, status: 404, error: `Organization not found: "${scopeId}"` };
    }
    if (String(org._id) !== String(user.organizationId)) {
      return { ok: false, status: 403, error: 'You can only publish to your own organization scope' };
    }
    return { ok: true };
  }

  if (tier === 'project') {
    // scopeId is a Project._id. Allow the owner (userId) or a member.
    // Membership rows store userId (sharingService pushShareable); path is users.userId, not users.id.
    const { Project } = await import('@bike4mind/database');
    const project = await Project.findOne({
      _id: scopeId,
      $or: [{ userId: String(user.id) }, { 'users.userId': String(user.id) }],
    })
      .select('_id')
      .lean<{ _id: unknown } | null>();
    if (!project) {
      // Distinguish "no access" from "does not exist" without a second query is
      // not worth it here; 403 is the safe default (don't leak project existence).
      return { ok: false, status: 403, error: 'You can only publish to projects you can access' };
    }
    return { ok: true };
  }

  return { ok: false, status: 403, error: `Unknown scope: ${tier}` };
}
