import { hasDeveloperUserTag, type CoreTutorialVisibility } from '@bike4mind/common';
import { userHasEntitlement, type EntitlementUser } from '@bike4mind/server-utils/entitlements/index';

/**
 * Whether the user may see a core tutorial. Admins and developers see everything, as the client gate does;
 * the developer bypass lives here because `userHasEntitlement` bypasses for admins only.
 */
export async function coreTutorialVisibleTo(
  user: EntitlementUser,
  visibility: CoreTutorialVisibility
): Promise<boolean> {
  if ('public' in visibility) return true;
  if (user.isAdmin || hasDeveloperUserTag(user.tags)) return true;
  return userHasEntitlement(user, visibility.entitlement);
}

export async function filterCoreTutorialsVisibleTo<T extends { visibility: CoreTutorialVisibility }>(
  user: EntitlementUser,
  tutorials: readonly T[]
): Promise<T[]> {
  const visible = await Promise.all(tutorials.map(t => coreTutorialVisibleTo(user, t.visibility)));
  return tutorials.filter((_, i) => visible[i]);
}
