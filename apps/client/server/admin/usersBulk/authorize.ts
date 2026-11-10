import { ForbiddenError } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';
import { requireAdminPermission } from '@server/middlewares/adminApi';
import {
  ADMIN_USERS_BULK_ACTION_PERMISSIONS,
  type AdminUsersBulkActionType,
} from '@client/app/utils/adminUsersBulk';

type BulkAuthorizationRequest = Parameters<typeof requireAdminPermission>[0] & {
  ability?: { can(action: string, subject: unknown): boolean };
};

/**
 * Every permission the action needs, plus the settings permission when it writes blockedEmailDomains.
 * Shared by execute, undo and the approver's run so the three paths cannot drift.
 */
export function assertCanRunUsersBulkAction(
  req: BulkAuthorizationRequest,
  type: AdminUsersBulkActionType,
  domains: { blocks?: boolean; unblocks?: boolean } = {}
): void {
  for (const permission of ADMIN_USERS_BULK_ACTION_PERMISSIONS[type]) requireAdminPermission(req, permission);
  if ((domains.blocks || domains.unblocks) && !req.ability?.can('update', AdminSettings)) {
    throw new ForbiddenError(
      `${domains.blocks ? 'Blocking' : 'Unblocking'} email domains needs permission to edit admin settings.`
    );
  }
}
