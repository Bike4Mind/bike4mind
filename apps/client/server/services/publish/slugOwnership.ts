/**
 * Error `code` a bundle publish returns when its target slug is owned by another user.
 * Also read by the web client's derived-slug retry in `app/utils/publishApi.ts`.
 */
export { SLUG_OWNED_BY_OTHER } from '@bike4mind/common';

/**
 * Only the owner (or an admin) may republish an existing {tier, scopeId, slug}. Checked at
 * upload-url so a refused publish uploads nothing, and again at finalize.
 */
export function mayRepublishSlug(ownerId: string, user: { id: string; isAdmin?: boolean }): boolean {
  return ownerId === user.id || !!user.isAdmin;
}
