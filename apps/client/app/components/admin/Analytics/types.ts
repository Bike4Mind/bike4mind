export enum AnalyticsSubTab {
  UserActivity = 'user_activity',
  DailyReport = 'daily_report',
  WeeklyReport = 'weekly_report',
}

export interface TabConfig {
  id: AnalyticsSubTab;
  label: string;
}

export interface ExcludedOrgs {
  millionOnMars: boolean;
  unknown: boolean;
  personal: boolean;
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
  excludedOrgs: ExcludedOrgs;
  dateFilters: DateFilters;
  userActivityFilters: UserActivityFilters;
  showUserActivityAdvancedFilters: boolean;
  setActiveSubTab: (tab: AnalyticsSubTab) => void;
  setSelectedOrganizations: (orgs: string[]) => void;
  toggleExcludedOrg: (key: keyof ExcludedOrgs) => void;
  setDateFilters: (filters: DateFilters) => void;
  setUserActivityFilters: (filters: Partial<UserActivityFilters>) => void;
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
