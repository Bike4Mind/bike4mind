import { ALL_VALUE } from './store';
import type { AnalyticsState, MetadataFilter } from './types';

/** Display names as denormalised onto CounterLog.userOrganization. */
const EXCLUDABLE_ORG_NAMES: Record<string, string> = {
  millionOnMars: 'Million on Mars',
  unknown: 'Unknown',
  personal: 'Personal',
};

export type UserActivityRequestState = Pick<
  AnalyticsState,
  'dateFilters' | 'selectedOrganizations' | 'excludedOrgs' | 'userActivityFilters' | 'metadataFilters'
>;

export interface UserActivityRequest {
  startDate: string;
  endDate: string;
  orgs: string[] | null;
  excludeOrgs: string[];
  counterName?: string;
  userEmail?: string;
  metadataFilters?: MetadataFilter[];
}

/**
 * The single description of "which rows the user is asking for", shared by the grid query
 * and the CSV export so the exported file always matches what the grid shows.
 *
 * The exclusion checkboxes only apply while "All Organizations" is selected - that is also
 * the only time the UI enables them.
 */
export function buildUserActivityRequest({
  dateFilters,
  selectedOrganizations,
  excludedOrgs,
  userActivityFilters,
  metadataFilters,
}: UserActivityRequestState): UserActivityRequest {
  const isAllSelected = selectedOrganizations.includes(ALL_VALUE);

  return {
    startDate: dateFilters.startDate,
    endDate: dateFilters.endDate,
    orgs: isAllSelected ? null : selectedOrganizations,
    excludeOrgs: isAllSelected
      ? Object.entries(excludedOrgs)
          .filter(([, isExcluded]) => isExcluded)
          .map(([key]) => EXCLUDABLE_ORG_NAMES[key] ?? key)
      : [],
    counterName: userActivityFilters.counterNameSearch || undefined,
    userEmail: userActivityFilters.userEmailSearch || undefined,
    metadataFilters: metadataFilters.length ? metadataFilters : undefined,
  };
}
