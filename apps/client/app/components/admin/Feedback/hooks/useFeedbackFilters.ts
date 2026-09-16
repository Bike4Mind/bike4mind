import { useCallback, useMemo, useState } from 'react';
import { FeedbackStatus } from '@bike4mind/common';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { FeedbackFilters, FeedbackListFilterParams, UseFeedbackFiltersReturn } from '../types';

/**
 * Filter state for the feedback list, and the server query it maps to.
 *
 * Filtering is server-side because the list is paginated: a predicate applied to the page on
 * screen can only ever filter one page of matches, which reads as data silently going missing.
 * Every setter also calls `onFilterChange` so the page cursor resets - otherwise narrowing the
 * filters can leave the caller on a page number the new result set does not reach.
 *
 * The organization filter used to be inert: the predicate read `selectedOrganization` from
 * OrganizationContext, which nothing in the app ever sets (it is fixed at ['all'], so the
 * predicate always passed), while the dropdown wrote to a separate `selectedOrganizations` state
 * that nothing read. The dropdown's selection now reaches the query.
 */
export const useFeedbackFilters = (onFilterChange: () => void): UseFeedbackFiltersReturn => {
  const { value: searchTerm, debouncedValue: debouncedSearchTerm, setValue: setSearchTermValue } = useDebounceValue('');

  const [statusFilters, setStatusFiltersState] = useState<Record<FeedbackStatus, boolean>>({
    [FeedbackStatus.New]: true,
    [FeedbackStatus.InProgress]: false,
    [FeedbackStatus.Closed]: false,
  });
  const [selectedOrganizations, setSelectedOrganizationsState] = useState<string[]>([]);
  const [sortAscending, setSortAscending] = useState(false);

  const setSearchTerm = useCallback(
    (term: string) => {
      setSearchTermValue(term);
      onFilterChange();
    },
    [setSearchTermValue, onFilterChange]
  );

  const setStatusFilters = useCallback<UseFeedbackFiltersReturn['setStatusFilters']>(
    update => {
      setStatusFiltersState(update);
      onFilterChange();
    },
    [onFilterChange]
  );

  const setSelectedOrganizations = useCallback(
    (orgs: string[]) => {
      setSelectedOrganizationsState(orgs);
      onFilterChange();
    },
    [onFilterChange]
  );

  const toggleSortDirection = useCallback(() => {
    setSortAscending(previous => !previous);
    onFilterChange();
  }, [onFilterChange]);

  const filters: FeedbackFilters = { searchTerm, statusFilters, selectedOrganizations, sortAscending };

  const filterParams = useMemo<FeedbackListFilterParams>(() => {
    const statuses = Object.values(FeedbackStatus).filter(status => statusFilters[status]);
    return {
      // Omitted rather than sent empty: an empty array would be serialized as no filter anyway,
      // and `status` absent is the server's "any status".
      ...(statuses.length > 0 ? { status: statuses } : {}),
      ...(selectedOrganizations.length > 0 ? { organization: selectedOrganizations } : {}),
      ...(debouncedSearchTerm.trim() ? { search: debouncedSearchTerm.trim() } : {}),
      sort: sortAscending ? 'asc' : 'desc',
    };
  }, [statusFilters, selectedOrganizations, debouncedSearchTerm, sortAscending]);

  return {
    filters,
    setSearchTerm,
    setStatusFilters,
    setSelectedOrganizations,
    toggleSortDirection,
    filterParams,
  };
};
