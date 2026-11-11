import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdminPermissionId, AdminUserPermissionsChange } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { adminUpdateErrorMessage } from './useAdminUserUpdate';

/** Writes through `PUT /api/admin/users/[userId]/permissions`; the step-up interceptor handles verification. */
export const useAdminUserPermissionsUpdate = (userId: string) => {
  const cache = useQueryClient();
  return async (input: AdminUserPermissionsChange) => {
    try {
      const response = await api.put<{ adminPermissions: AdminPermissionId[] }>(
        `/api/admin/users/${userId}/permissions`,
        input
      );
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['users'] }),
        cache.invalidateQueries({ queryKey: ['admin', 'users', userId] }),
      ]);
      return response.data.adminPermissions;
    } catch (error) {
      if (!isStepUpCancelled(error)) {
        toast.error(adminUpdateErrorMessage(error, 'Admin permissions were not saved.'));
      }
      throw error;
    }
  };
};
