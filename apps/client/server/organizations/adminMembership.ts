import { ForbiddenError, isFullAdmin } from '@bike4mind/common';

/**
 * The admin membership routes (pages/api/admin/organizations/[id]/members) act through
 * organizationService, whose roster authority admits a platform admin only by the `isAdmin` flag,
 * so a delegated `users:moderate` admin is refused here with a plain message instead of a not-found.
 */
export const assertFullAdminForMembership = (user: { isAdmin?: boolean | null } | undefined): void => {
  if (!isFullAdmin(user)) throw new ForbiddenError('Only full administrators can change organization membership');
};
