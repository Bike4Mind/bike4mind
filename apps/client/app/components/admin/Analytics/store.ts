import { create } from 'zustand';
import dayjs from 'dayjs';
import { DEFAULT_PAGE_SIZE } from '@server/analytics/metadataFilterContract';
import { AnalyticsState, AnalyticsSubTab } from './types';

const getLocalDate = (daysOffset = 0) => {
  const now = dayjs();
  return now.add(daysOffset, 'day').format('YYYY-MM-DD');
};

export const ALL_VALUE = 'all';

export { DEFAULT_PAGE_SIZE };

/**
 * User Activity rows are paged and filtered by the server (see server/analytics/
 * userActivityQuery.ts), so this store is the single source of truth for the query:
 * every filter change resets to page 1, since the old page may not exist in the new
 * result set.
 */
export const useAnalyticsStore = create<AnalyticsState>(set => ({
  activeSubTab: AnalyticsSubTab.UserActivity,
  selectedOrganizations: [ALL_VALUE],
  excludedOrgs: {
    millionOnMars: true,
    unknown: true,
    personal: true,
  },
  dateFilters: {
    startDate: getLocalDate(-7),
    endDate: getLocalDate(),
  },
  userActivityFilters: {
    counterNameSearch: '',
    userEmailSearch: '',
  },
  metadataFilters: [],
  page: 1,
  limit: DEFAULT_PAGE_SIZE,
  showUserActivityAdvancedFilters: false,
  setActiveSubTab: tab => set({ activeSubTab: tab, page: 1 }),
  setSelectedOrganizations: orgs => set({ selectedOrganizations: orgs, page: 1 }),
  toggleExcludedOrg: key =>
    set(state => ({
      excludedOrgs: {
        ...state.excludedOrgs,
        [key]: !state.excludedOrgs[key],
      },
      page: 1,
    })),
  setDateFilters: filters => set({ dateFilters: filters, page: 1 }),
  setUserActivityFilters: filters =>
    set(state => ({
      userActivityFilters: {
        ...state.userActivityFilters,
        ...filters,
      },
      page: 1,
    })),
  setMetadataFilters: filters => set({ metadataFilters: filters, page: 1 }),
  setPage: page => set({ page }),
  setLimit: limit => set({ limit, page: 1 }),
  setShowUserActivityAdvancedFilters: (show: boolean) => set({ showUserActivityAdvancedFilters: show }),
}));
