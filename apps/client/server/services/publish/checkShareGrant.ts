import type { PublishUser } from './checkScopePermission';
import { checkAccessGate, type AccessGateShape, type VisibilityContext, type VisibilityResult } from './checkVisibility';

/**
 * Publish - access gate for no-sign-in `/a/<shareToken>` links, sibling to
 * checkVisibility (which stays the pure visibility-enum/membership ladder). The
 * share token has already been resolved to this artifact by the caller, so for
 * Tier-1 link-public sharing possession of the token IS the read grant: this
 * returns ok even when `visibility !== 'public'`.
 *
 * Tiers 2+3 (issue #383) layer the artifact's optional `accessGate` ON TOP of
 * token possession, through the same checkAccessGate the /p/* path uses:
 *  - passphrase: the caller verifies the per-artifact proof cookie (minted by
 *    POST /api/publish/gate/passphrase) and passes `ctx.passphraseVerified`;
 *    the raw passphrase never rides ordinary requests.
 *  - domain: requires `ctx.user` with a VERIFIED email whose domain exact-matches
 *    the record's allowlist.
 * Owner/admin always pass their own gate.
 */
export interface ShareGrantArtifact {
  ownerId: string;
  accessGate?: AccessGateShape | null;
}

export type ShareGrantContext = VisibilityContext & {
  user?: PublishUser;
};

export async function checkShareGrant(artifact: ShareGrantArtifact, ctx: ShareGrantContext): Promise<VisibilityResult> {
  return checkAccessGate(artifact.accessGate, artifact.ownerId, ctx.user, ctx);
}
