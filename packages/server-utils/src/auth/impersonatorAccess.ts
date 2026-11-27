import { hasAdminPermission } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { resolveRoleAdminPermissions } from './adminRoles';

/**
 * Whether the admin behind a support session may still drive it: the account exists, is not
 * blocked, and still holds `users:impersonate` (directly or through a role). Checked on every
 * impersonated request (verifyJwtPayload.ts) and refresh (refreshToken.ts -> rotateSession), so a
 * change to the admin's access ends their support sessions (minted by users/[id]/loginAs.ts) on
 * the next request rather than at the session's expiry.
 */
export async function isImpersonatorAuthorized(adminId: string): Promise<boolean> {
  const admin = await User.findById(adminId);
  if (!admin || admin.isSystem) return false;
  if (userService.accountBlockReasons(admin).length > 0) return false;
  await resolveRoleAdminPermissions(admin);
  return hasAdminPermission(admin, 'users:impersonate');
}
