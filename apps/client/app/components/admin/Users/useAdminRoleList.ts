import { useQuery } from '@tanstack/react-query';
import { hasAdminPermission, type AdminRole } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';

/** A role as GET /api/admin/admin-roles answers it, member count included. */
export type AdminRoleListItem = Pick<AdminRole, 'id' | 'name' | 'description' | 'permissions'> & {
  memberCount: number;
};

/** Shared with the Roles tab's hooks, so a role edit there refreshes the pickers here. */
export const ADMIN_ROLES_QUERY_KEY = ['admin', 'roles'] as const;

/** Every admin role, for the role picker and the users-list filter. The route needs `support:read`. */
export const useAdminRoleList = () => {
  const { currentUser } = useUser();
  return useQuery({
    queryKey: ADMIN_ROLES_QUERY_KEY,
    queryFn: async (): Promise<AdminRoleListItem[]> =>
      (await api.get<{ roles: AdminRoleListItem[] }>('/api/admin/admin-roles')).data.roles,
    enabled: hasAdminPermission(currentUser, 'support:read'),
  });
};
