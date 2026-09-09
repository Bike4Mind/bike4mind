import { Permission } from '../types/entities/ShareableDocumentTypes';

/**
 * Update-level access to a shareable document, for the call sites that hold the document already
 * and so cannot re-resolve it through the repository's findUpdateAccessById. Structural rather
 * than tied to one document interface, so a raw driver lookup satisfies it too.
 *
 * Mirrors findUpdateAccessById's three arms (owner, users[].update, groups[].update); the
 * read-level counterpart is isSessionOwnedByUser in apps/client, which any share satisfies.
 */
export interface ShareableAccessShape {
  userId: string;
  users?: Array<{ userId: string; permissions?: readonly string[] }> | null;
  groups?: Array<{ groupId: string; permissions?: readonly string[] }> | null;
}

export function canUpdateShareable(
  doc: ShareableAccessShape | null | undefined,
  userId: string | undefined,
  userGroups: readonly string[] = []
): boolean {
  if (!doc || !userId) return false;
  if (doc.userId === userId) return true;

  const byUser = doc.users?.some(share => share.userId === userId && share.permissions?.includes(Permission.update));
  if (byUser) return true;

  return (
    doc.groups?.some(share => userGroups.includes(share.groupId) && share.permissions?.includes(Permission.update)) ??
    false
  );
}
