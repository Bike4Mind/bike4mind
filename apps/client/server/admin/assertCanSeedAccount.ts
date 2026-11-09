import { assertCanGrantAdminAccess, ForbiddenError, isFullAdmin } from '@bike4mind/common';
import { isManagedTag } from '@client/lib/entitlements/managedUserTags';
import { requireAdminPermission } from '@server/middlewares/adminApi';

type SeedRequest = Parameters<typeof requireAdminPermission>[0];

/**
 * What a delegated admin may give an account it creates, so the create routes cannot grant more
 * than the dedicated actions would: the admin role follows assertCanGrantAdminAccess, credits need
 * credits:adjust, and managed role/product tags stay full-admin only, as in the tag editor
 * (`pages/api/admin/users/[userId]/tags.ts`).
 */
export function assertCanSeedAccount(
  req: SeedRequest,
  seed: { isAdmin?: boolean; credits?: number; tags?: readonly string[] }
): void {
  if (seed.isAdmin) assertCanGrantAdminAccess(req.user, { isAdmin: true });
  if ((seed.credits ?? 0) > 0) requireAdminPermission(req, 'credits:adjust');
  if (!isFullAdmin(req.user) && seed.tags?.some(isManagedTag)) {
    throw new ForbiddenError('Only full administrators can assign managed tags');
  }
}
