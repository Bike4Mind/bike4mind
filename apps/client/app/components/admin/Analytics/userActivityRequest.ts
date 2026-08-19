import { METADATA_FIELD } from '@server/analytics/metadataFilterContract';
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

  // "Add Filter" seeds a blank field when the current page carries no metadata to suggest from,
  // and the dropdown itself can suggest a key the allowlist rejects (leading digit/underscore,
  // spaces, too many dot segments). Either would fail the server's field allowlist and 400 the
  // whole grid, where the pre-pagination client just skipped it. An unfinished or unacceptable
  // filter row is not a query.
  const activeMetadataFilters = metadataFilters.filter(
    filter => filter.field.trim() !== '' && METADATA_FIELD.test(filter.field.trim())
  );

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
    metadataFilters: activeMetadataFilters.length ? activeMetadataFilters : undefined,
  };
}
