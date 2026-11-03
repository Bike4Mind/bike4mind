import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type {
  AdminUsersDomainGroupsResponse,
  AdminUsersFilter,
  AdminUsersListResponse,
  AdminUsersSummary,
} from '@client/app/utils/adminUsersFilter';
import { USERS_FILTER_KEYS, type UsersListParams } from '../usersTabSearch';

const LIST_STALE_MS = 30_000;

/** The API filter for the list params: 'all' organizations and empty lists narrow nothing. */
export function toAdminUsersFilter(params: UsersListParams): AdminUsersFilter {
  return {
    ...Object.fromEntries(USERS_FILTER_KEYS.map(key => [key, params[key]]).filter(([, value]) => value !== undefined)),
    ...(params.search.trim() ? { search: params.search.trim() } : {}),
    ...(params.orgSearch.length > 0 && !params.orgSearch.includes('all') ? { orgSearch: params.orgSearch } : {}),
    ...(params.tags.length > 0 ? { tags: params.tags } : {}),
  };
}

// Nested under 'users' so the existing ['users'] invalidations (CreateUserModal, the
// profile actions, bulk abuse) refresh the list too.
export const adminUsersQueryKey = ['users', 'admin-list'] as const;

export function useAdminUsersList(params: UsersListParams) {
  const query = {
    ...toAdminUsersFilter(params),
    page: params.page,
    limit: params.limit,
    sortField: params.sortField,
    sortOrder: params.sortOrder,
  };
  return useQuery({
    queryKey: [...adminUsersQueryKey, 'page', query],
    queryFn: async () => (await api.get<AdminUsersListResponse>('/api/admin/users', { params: query })).data,
    placeholderData: keepPreviousData,
    staleTime: LIST_STALE_MS,
  });
}

/** Email-domain groups for the same filter, fetched only while grouping. */
export function useAdminUsersDomainGroups(params: UsersListParams) {
  const filter = toAdminUsersFilter(params);
  return useQuery({
    queryKey: [...adminUsersQueryKey, 'groups', filter],
    queryFn: async () =>
      (
        await api.get<AdminUsersDomainGroupsResponse>('/api/admin/users', {
          params: { ...filter, groupBy: 'emailDomain' },
        })
      ).data,
    enabled: params.groupBy === 'emailDomain',
    placeholderData: keepPreviousData,
    staleTime: LIST_STALE_MS,
  });
}

export function useAdminUsersSummary() {
  return useQuery({
    queryKey: [...adminUsersQueryKey, 'summary'],
    queryFn: async () => (await api.get<AdminUsersSummary>('/api/admin/users/summary')).data,
    staleTime: 60_000,
  });
}
