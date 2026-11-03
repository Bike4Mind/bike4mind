import { create } from 'zustand';
import { DEFAULT_PAGE_SIZE } from '@server/analytics/metadataFilterContract';
import { AnalyticsState, AnalyticsSubTab } from './types';
import { DEFAULT_PRESET_DAYS, getPresetRange } from './dateRange';

export const ALL_VALUE = 'all';

/**
 * An empty selection would filter on nothing, so it means "All": the label, the enabled
 * exclusion checkboxes and the request then all describe the same state.
 */
export const isAllOrganizations = (selected: string[]) => selected.length === 0 || selected.includes(ALL_VALUE);

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
  exclusions: {
    noOrg: true,
    staff: true,
  },
  dateFilters: getPresetRange(DEFAULT_PRESET_DAYS),
  isDefaultDateRange: true,
  userActivityFilters: {
    counterNameSearch: '',
    userEmailSearch: '',
  },
  metadataFilters: [],
  page: 1,
  limit: DEFAULT_PAGE_SIZE,
  showUserActivityAdvancedFilters: false,
  setActiveSubTab: tab => set({ activeSubTab: tab, page: 1 }),
  setSelectedOrganizations: orgs =>
    set({ selectedOrganizations: isAllOrganizations(orgs) ? [ALL_VALUE] : orgs, page: 1 }),
  toggleExclusion: key =>
    set(state => ({
      exclusions: {
        ...state.exclusions,
        [key]: !state.exclusions[key],
      },
      page: 1,
    })),
  setDateFilters: filters => set({ dateFilters: filters, isDefaultDateRange: false, page: 1 }),
  // The default above is computed once at module load; re-anchor it to today so a long-lived
  // SPA does not keep a "Last 7 Days" that ends yesterday.
  refreshDefaultDateFilters: () =>
    set(state => {
      if (!state.isDefaultDateRange) return state;
      const fresh = getPresetRange(DEFAULT_PRESET_DAYS);
      const unchanged = fresh.startDate === state.dateFilters.startDate && fresh.endDate === state.dateFilters.endDate;
      return unchanged ? state : { dateFilters: fresh, page: 1 };
    }),
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
