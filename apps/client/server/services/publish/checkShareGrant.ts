import type { PublishUser } from './checkScopePermission';
import type { VisibilityResult } from './checkVisibility';

/**
 * Publish - access gate for no-sign-in `/a/<shareToken>` links, sibling to
 * checkVisibility (which stays the pure visibility-enum/membership ladder). The
 * share token has already been resolved to this artifact by the caller, so for
 * Tier-1 link-public sharing possession of the token IS the read grant: this
 * returns ok even when `visibility !== 'public'`.
 *
 * This is the seam where later tiers gate a token WITHOUT touching checkVisibility:
 *  - Tier 2 passphrase: compare `ctx.passphrase` against the record's stored hash.
 *  - Tier 3 domain-restricted: require `ctx.user` with a verified email whose
 *    registrable domain matches the record's allowlist.
 * Kept async so those checks (hash compare / domain lookup) need no signature change.
 */
export interface ShareGrantArtifact {
  ownerId: string;
}

export interface ShareGrantContext {
  user?: PublishUser;
  passphrase?: string;
}

export async function checkShareGrant(
  _artifact: ShareGrantArtifact,
  _ctx: ShareGrantContext
): Promise<VisibilityResult> {
  return { ok: true };
}
