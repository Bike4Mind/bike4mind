import type { MetadataFilter } from '@server/analytics/metadataFilterContract';

export type { MetadataFilter };

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
