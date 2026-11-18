import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdminPermissionId, AdminUserPermissionsChange } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { ADMIN_ROLES_QUERY_KEY } from '../../useAdminRoleList';
import { adminUpdateErrorMessage } from './useAdminUserUpdate';

export type AdminUserAccess = { adminPermissions: AdminPermissionId[]; adminRoleIds: string[] };

/** Writes through `PUT /api/admin/users/[userId]/permissions`; the step-up interceptor handles verification. */
export const useAdminUserPermissionsUpdate = (userId: string) => {
  const cache = useQueryClient();
  return async (input: AdminUserPermissionsChange): Promise<AdminUserAccess> => {
    try {
      const response = await api.put<AdminUserAccess>(`/api/admin/users/${userId}/permissions`, input);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['users'] }),
        cache.invalidateQueries({ queryKey: ['admin', 'users', userId] }),
        // Member counts on the Roles tab move with an assignment.
        ...(input.adminRoleIds !== undefined ? [cache.invalidateQueries({ queryKey: ADMIN_ROLES_QUERY_KEY })] : []),
      ]);
      return response.data;
    } catch (error) {
      if (!isStepUpCancelled(error)) {
        toast.error(adminUpdateErrorMessage(error, 'Admin permissions were not saved.'));
      }
      throw error;
    }
  };
};
