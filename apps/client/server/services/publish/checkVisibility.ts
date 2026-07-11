import type { PublishVisibility } from '@bike4mind/common';
import type { PublishUser } from './checkScopePermission';

/**
 * Publish - shared visibility gate for a PublishedArtifact. One code path for
 * "may this caller VIEW this artifact", used by both the public viewer and the
 * annotation routes.
 *
 * Visibility ladder { private, project, organization, public }:
 *  - public          -> anyone, even anonymous
 *  - organization     -> same-org members (org tier stores org _id as scopeId)
 *  - project          -> project owner or member
 *  - private          -> owner / admin only
 *
 * A `public` artifact may additionally carry an `accessGate`:
 *  - passphrase -> anyone with the link who has presented the passphrase this
 *                  session (proof cookie -> ctx.passphraseVerified)
 *  - domain     -> logged-in viewers whose VERIFIED email domain is allowlisted
 * Owner/admin always pass their own gate.
 */

/** The minimal artifact shape the gate needs. */
export interface VisibilityCheckArtifact {
  visibility: PublishVisibility;
  ownerId: string;
  scopeId: string;
  /**
   * Gate on top of `public` - passphrase or verified-email-domain.
   * REQUIRED (explicit `null` when absent), NOT optional: an optional field let
   * a caller silently bypass the gate by not selecting it in its Mongoose
   * projection. Making it required forces every caller to load `accessGate` and
   * pass it, so a missing projection is a compile error, not a silent bypass.
   */
  accessGate: {
    kind: 'passphrase' | 'domain';
    allowedDomains?: string[];
  } | null;
}

/** Per-request facts the caller has already established (never raw secrets). */
export interface VisibilityContext {
  /** True when the request carried a valid passphrase-proof cookie for THIS artifact. */
  passphraseVerified?: boolean;
}

export type VisibilityResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403;
      error: string;
      /** Set for gate denials so the serve route can render the right prompt
       *  (passphrase form) instead of a bare status. */
      reason?: 'passphrase' | 'domain';
    };

export async function checkVisibility(
  artifact: VisibilityCheckArtifact,
  user: PublishUser | undefined,
  ctx: VisibilityContext = {}
): Promise<VisibilityResult> {
  if (artifact.visibility === 'public') {
    return checkAccessGate(artifact.accessGate, artifact.ownerId, user, ctx);
  }
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

/** The gate shape checkAccessGate enforces (matches the model's accessGate sub-doc). */
export interface AccessGateShape {
  kind: 'passphrase' | 'domain';
  allowedDomains?: string[];
}

/**
 * Enforce an artifact's optional access gate. Shared by BOTH share surfaces:
 * checkVisibility applies it on top of `visibility: 'public'` (/p/*), and
 * checkShareGrant applies it on top of token possession (/a/<shareToken>).
 * Owner/admin always pass their own gate.
 */
export async function checkAccessGate(
  gate: AccessGateShape | null | undefined,
  ownerId: string,
  user: PublishUser | undefined,
  ctx: VisibilityContext = {}
): Promise<VisibilityResult> {
  if (!gate) return { ok: true };
  // Owner/admin never gate themselves out of their own artifact.
  if (user?.id && (user.isAdmin || ownerId === String(user.id))) return { ok: true };

  if (gate.kind === 'passphrase') {
    if (ctx.passphraseVerified) return { ok: true };
    return { ok: false, status: 401, error: 'Passphrase required', reason: 'passphrase' };
  }
  // gate.kind === 'domain': requires login + a VERIFIED email on an allowlisted domain.
  if (!user?.id) {
    return { ok: false, status: 401, error: 'Authentication required', reason: 'domain' };
  }
  const allowed = (gate.allowedDomains ?? []).map(d => d.toLowerCase());
  if (allowed.length === 0) {
    // A domain gate with no domains is a misconfiguration; fail closed.
    return { ok: false, status: 403, error: 'Not authorized', reason: 'domain' };
  }
  const { User } = await import('@bike4mind/database');
  const viewer = await User.findById(String(user.id))
    .select('email emailVerified')
    .lean<{ email?: string; emailVerified?: boolean } | null>();
  const email = viewer?.email?.toLowerCase() ?? '';
  const domain = email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : '';
  // Exact domain match only - no substring/suffix matching - and only for
  // VERIFIED emails (same rule as the entitlement domain grants).
  if (viewer?.emailVerified === true && domain && allowed.includes(domain)) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: 'Your verified email domain is not authorized for this shared item',
    reason: 'domain',
  };
}
