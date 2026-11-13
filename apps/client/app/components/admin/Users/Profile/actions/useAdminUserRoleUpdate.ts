import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { adminUpdateErrorMessage } from './useAdminUserUpdate';

/** Grants or revokes the Super Admin role through `PUT /api/admin/users/[userId]/role`. */
export const useAdminUserRoleUpdate = (userId: string) => {
  const cache = useQueryClient();
  return async (input: { isAdmin: boolean; reason: string }) => {
    try {
      const response = await api.put<{ isAdmin: boolean }>(`/api/admin/users/${userId}/role`, input);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['users'] }),
        cache.invalidateQueries({ queryKey: ['admin', 'users', userId] }),
      ]);
      return response.data.isAdmin;
    } catch (error) {
      if (!isStepUpCancelled(error)) toast.error(adminUpdateErrorMessage(error, 'The role was not changed.'));
      throw error;
    }
  };
};
