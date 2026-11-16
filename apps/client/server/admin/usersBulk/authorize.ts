import { ForbiddenError, isFullAdmin } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';
import { isManagedTag } from '@client/lib/entitlements/managedUserTags';
import { requireAdminPermission } from '@server/middlewares/adminApi';
import {
  ADMIN_USERS_BULK_ACTION_PERMISSIONS,
  type AdminUsersBulkActionType,
} from '@bike4mind/server-utils/app/utils/adminUsersBulk';

type BulkAuthorizationRequest = Parameters<typeof requireAdminPermission>[0] & {
  ability?: { can(action: string, subject: unknown): boolean };
};

/**
 * Every permission the action needs, plus the settings permission when it writes blockedEmailDomains.
 * Managed role/product tags it adds or removes stay full-admin only, as in the single-user tag editor.
 * Shared by execute, undo and the approver's run so the three paths cannot drift.
 */
export function assertCanRunUsersBulkAction(
  req: BulkAuthorizationRequest,
  type: AdminUsersBulkActionType,
  effects: { blocks?: boolean; unblocks?: boolean; tags?: readonly string[] } = {}
): void {
  for (const permission of ADMIN_USERS_BULK_ACTION_PERMISSIONS[type]) requireAdminPermission(req, permission);
  if ((effects.blocks || effects.unblocks) && !req.ability?.can('update', AdminSettings)) {
    throw new ForbiddenError(
      `${effects.blocks ? 'Blocking' : 'Unblocking'} email domains needs permission to edit admin settings.`
    );
  }
  if (!isFullAdmin(req.user) && effects.tags?.some(isManagedTag)) {
    throw new ForbiddenError('Only full administrators can assign managed tags');
  }
}

/** The tag an execute request would add, for assertCanRunUsersBulkAction. */
export const tagsAddedBy = (action: { type: string; tag?: string }): string[] =>
  action.type === 'addTag' && action.tag ? [action.tag] : [];
