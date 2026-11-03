import type { MetadataFilter } from '@server/analytics/metadataFilterContract';

export type { MetadataFilter };

export enum AnalyticsSubTab {
  UserActivity = 'user_activity',
  DailyReport = 'daily_report',
  WeeklyReport = 'weekly_report',
}

export interface TabConfig {
  id: AnalyticsSubTab;
  label: string;
}

/** The User Activity grid's "Exclude" checkboxes. */
export interface UserActivityExclusions {
  /** Rows whose counter log carries no organization. */
  noOrg: boolean;
  /** Admin, system and synthetic accounts, and emails on the internal staff domains. */
  staff: boolean;
}

export interface DateFilters {
  startDate: string;
  endDate: string;
}

export interface UserActivityFilters {
  counterNameSearch: string;
  userEmailSearch: string;
}

export interface AnalyticsState {
  activeSubTab: AnalyticsSubTab;
  selectedOrganizations: string[];
  exclusions: UserActivityExclusions;
  dateFilters: DateFilters;
  /** True until the range is picked by hand, while it should still follow the default preset. */
  isDefaultDateRange: boolean;
  userActivityFilters: UserActivityFilters;
  metadataFilters: MetadataFilter[];
  page: number;
  limit: number;
  showUserActivityAdvancedFilters: boolean;
  setActiveSubTab: (tab: AnalyticsSubTab) => void;
  setSelectedOrganizations: (orgs: string[]) => void;
  toggleExclusion: (key: keyof UserActivityExclusions) => void;
  setDateFilters: (filters: DateFilters) => void;
  refreshDefaultDateFilters: () => void;
  setUserActivityFilters: (filters: Partial<UserActivityFilters>) => void;
  setMetadataFilters: (filters: MetadataFilter[]) => void;
  setPage: (page: number) => void;
  setLimit: (limit: number) => void;
  setShowUserActivityAdvancedFilters: (show: boolean) => void;
}

export const TABS: Record<AnalyticsSubTab, TabConfig> = {
  [AnalyticsSubTab.UserActivity]: {
    id: AnalyticsSubTab.UserActivity,
    label: 'User Activity',
  },
  [AnalyticsSubTab.DailyReport]: {
    id: AnalyticsSubTab.DailyReport,
    label: 'Daily Report',
  },
  [AnalyticsSubTab.WeeklyReport]: {
    id: AnalyticsSubTab.WeeklyReport,
    label: 'Weekly Report',
  },
};
