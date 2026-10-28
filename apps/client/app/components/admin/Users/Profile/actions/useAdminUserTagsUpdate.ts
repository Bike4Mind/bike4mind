import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';

export const useAdminUserTagsUpdate = (userId: string) => {
  const cache = useQueryClient();
  return async (input: { before: string[]; tags: string[] }) => {
    try {
      await api.patch(`/api/admin/users/${userId}/tags`, input);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['users'] }),
        cache.invalidateQueries({ queryKey: ['admin', 'users', userId] }),
        cache.invalidateQueries({ queryKey: ['admin', 'user-entitlements', userId] }),
      ]);
    } catch (error) {
      toast.error('Tags were not saved. Reload the profile and try again.');
      throw error;
    }
  };
};
