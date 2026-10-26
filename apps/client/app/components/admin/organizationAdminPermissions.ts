import { hasAdminPermission, type AdminPermissionId } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { toast } from 'sonner';

/** Organization administration reads require support access as well as the action's grant. */
export function requireOrganizationAdminPermission(permission: AdminPermissionId): boolean {
  const actor = useUser.getState().currentUser;
  const missing = !hasAdminPermission(actor, 'support:read')
    ? 'support:read'
    : !hasAdminPermission(actor, permission)
      ? permission
      : undefined;
  if (!missing) return true;
  toast.error(`Missing permission: ${missing}`);
  return false;
}
