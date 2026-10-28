import { METADATA_FIELD } from '@server/analytics/metadataFilterContract';
import { ALL_VALUE } from './store';
import type { AnalyticsState, MetadataFilter } from './types';

export type UserActivityRequestState = Pick<
  AnalyticsState,
  'dateFilters' | 'selectedOrganizations' | 'exclusions' | 'userActivityFilters' | 'metadataFilters'
>;

export interface UserActivityRequest {
  startDate: string;
  endDate: string;
  orgs: string[] | null;
  excludeNoOrg: boolean;
  excludeStaff: boolean;
  counterName?: string;
  userEmail?: string;
  metadataFilters?: MetadataFilter[];
}

/**
 * The single description of "which rows the user is asking for", shared by the grid query
 * and the CSV export so the exported file always matches what the grid shows.
 *
 * "Exclude users without an org" only applies while "All Organizations" is selected: a specific
 * selection already matches named orgs only. The staff exclusion applies to every selection.
 */
export function buildUserActivityRequest({
  dateFilters,
  selectedOrganizations,
  exclusions,
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
    excludeNoOrg: isAllSelected && exclusions.noOrg,
    excludeStaff: exclusions.staff,
    counterName: userActivityFilters.counterNameSearch || undefined,
    userEmail: userActivityFilters.userEmailSearch || undefined,
    metadataFilters: activeMetadataFilters.length ? activeMetadataFilters : undefined,
  };
}
