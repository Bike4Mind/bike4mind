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

/**
 * The permissions an actor actually holds on a shareable document: every permission for the
 * owner, otherwise the union of their own users[] entry and the entries of groups they belong
 * to. Matched per entry, so it cannot reproduce the cross-entry over-grant the CASL abilities
 * carried (apps/client/server/auth/ability.ts).
 *
 * Used to cap what a re-sharer may grant: an invite must never carry a permission its minter
 * does not hold.
 */
export function heldPermissions(
  doc: ShareableAccessShape | null | undefined,
  userId: string | undefined,
  userGroups: readonly string[] = []
): Set<Permission> {
  const held = new Set<Permission>();
  if (!doc || !userId) return held;
  if (doc.userId === userId) {
    for (const permission of Object.values(Permission)) held.add(permission);
    return held;
  }

  const collect = (permissions: readonly string[] | undefined) => {
    for (const permission of permissions ?? []) {
      if ((Object.values(Permission) as string[]).includes(permission)) held.add(permission as Permission);
    }
  };

  for (const share of doc.users ?? []) if (share.userId === userId) collect(share.permissions);
  for (const share of doc.groups ?? []) if (userGroups.includes(share.groupId)) collect(share.permissions);

  return held;
}
