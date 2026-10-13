/**
 * Error `code` a bundle publish returns when its target slug is owned by another user.
 * Must stay in sync with the web client's retry in `app/utils/publishApi.ts`.
 */
export const SLUG_OWNED_BY_OTHER = 'slug_owned_by_other';

/**
 * Only the owner (or an admin) may republish an existing {tier, scopeId, slug}, except on the
 * organization tier: the scope permission check already proved org membership, and a teammate's
 * revision (ownerId unchanged, lastPublishedBy moved) is what lets an org page be handed over
 * when its owner's account is removed. Checked at upload-url so a refused publish uploads
 * nothing, and again at finalize.
 */
export function mayRepublishSlug(
  existing: { ownerId: string },
  tier: string,
  user: { id: string; isAdmin?: boolean }
): boolean {
  return tier === 'organization' || existing.ownerId === user.id || !!user.isAdmin;
}
