import { create } from 'zustand';
import dayjs from 'dayjs';
import { AnalyticsState, AnalyticsSubTab } from './types';

const getLocalDate = (daysOffset = 0) => {
  const now = dayjs();
  return now.add(daysOffset, 'day').format('YYYY-MM-DD');
};

export const ALL_VALUE = 'all';

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
  showUserActivityAdvancedFilters: false,
  setActiveSubTab: tab => set({ activeSubTab: tab }),
  setSelectedOrganizations: orgs => set({ selectedOrganizations: orgs }),
  toggleExcludedOrg: key =>
    set(state => ({
      excludedOrgs: {
        ...state.excludedOrgs,
        [key]: !state.excludedOrgs[key],
      },
    })),
  setDateFilters: filters => set({ dateFilters: filters }),
  setUserActivityFilters: filters =>
    set(state => ({
      userActivityFilters: {
        ...state.userActivityFilters,
        ...filters,
      },
    })),
  setShowUserActivityAdvancedFilters: (show: boolean) => set({ showUserActivityAdvancedFilters: show }),
}));
