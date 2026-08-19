import { IGetUsersParams } from '@client/app/utils/userAPICalls';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const PAGE_LIMIT_OPTIONS = [5, 10, 20];

export const DEFAULT_USERS_PARAMS: IGetUsersParams = {
  page: 1,
  limit: 10,
  search: '',
  sortField: 'createdAt',
  sortOrder: 'desc',
  orgSearch: ['all'],
  tags: [],
};

// Persist key must stay 'admin-user-tab-01': changing it silently discards
// every admin's saved filters.
export const useUsersTab = create<{
  params: IGetUsersParams;
  setParams: (params: Partial<IGetUsersParams>) => void;
}>()(
  persist(
    (set, get) => ({
      params: { ...DEFAULT_USERS_PARAMS },
      setParams: params => set({ params: { ...get().params, ...params } }),
    }),
    { name: 'admin-user-tab-01' }
  )
);

/** Filters that the mobile drawer's "Clear all" and the desktop filter chip reset. */
export const CLEARED_FILTER_PARAMS: Partial<IGetUsersParams> = {
  orgSearch: DEFAULT_USERS_PARAMS.orgSearch,
  tags: DEFAULT_USERS_PARAMS.tags,
  sortField: DEFAULT_USERS_PARAMS.sortField,
  sortOrder: DEFAULT_USERS_PARAMS.sortOrder,
  page: 1,
};

export const countActiveFilters = (params: IGetUsersParams): number => {
  let count = 0;
  if (params.orgSearch && !params.orgSearch.includes('all') && params.orgSearch.length > 0) count++;
  if (params.tags && params.tags.length > 0) count++;
  if (params.sortField !== DEFAULT_USERS_PARAMS.sortField || params.sortOrder !== DEFAULT_USERS_PARAMS.sortOrder) {
    count++;
  }
  return count;
};
