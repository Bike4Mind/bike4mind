import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AdminRole, AdminRoleCreate, AdminRoleUpdate } from '@bike4mind/common';

const ADMIN_ROLES_PATH = '/api/admin/admin-roles';
const rolePath = (id: string) => `${ADMIN_ROLES_PATH}/${encodeURIComponent(id)}`;

export const ADMIN_ROLES_QUERY_KEY = ['admin', 'roles'] as const;

/** A role as the list endpoint answers: the member count rides along, timestamps arrive as strings. */
export type AdminRoleRow = Omit<AdminRole, 'createdAt' | 'updatedAt' | 'createdBy'> & { memberCount: number };

export const useAdminRoles = () =>
  useQuery({
    queryKey: ADMIN_ROLES_QUERY_KEY,
    queryFn: async (): Promise<AdminRoleRow[]> =>
      (await api.get<{ roles: AdminRoleRow[] }>(ADMIN_ROLES_PATH)).data.roles,
  });

const useRefreshRoles = () => {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ADMIN_ROLES_QUERY_KEY });
};

export const useCreateAdminRole = () => {
  const refresh = useRefreshRoles();
  return useMutation({
    mutationFn: async (input: AdminRoleCreate): Promise<AdminRoleRow> =>
      (await api.post<AdminRoleRow>(ADMIN_ROLES_PATH, input)).data,
    onSuccess: refresh,
  });
};

export const useUpdateAdminRole = () => {
  const refresh = useRefreshRoles();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: AdminRoleUpdate }): Promise<AdminRoleRow> =>
      (await api.patch<AdminRoleRow>(rolePath(id), patch)).data,
    onSuccess: refresh,
  });
};

export const useDeleteAdminRole = () => {
  const refresh = useRefreshRoles();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await api.delete(rolePath(id));
    },
    // A refused delete (the role gained a member) still needs the fresh member count on screen.
    onSettled: refresh,
  });
};
