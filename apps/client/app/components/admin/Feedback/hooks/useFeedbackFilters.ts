import { useCallback, useMemo } from 'react';
import { FeedbackStatus, FeedbackSubject } from '@bike4mind/common';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { FeedbackFilters, FeedbackListFilterParams, UseFeedbackFiltersReturn } from '../types';
import { useFeedbackView } from './useFeedbackView';

/**
 * Filter state for the feedback list, and the server query it maps to. Status, organization,
 * subject and sort live in the URL (useFeedbackView); the free-text search stays local and never
 * enters it.
 *
 * Filtering is server-side because the list is paginated: a predicate applied to the page on
 * screen can only ever filter one page of matches, which reads as data silently going missing.
 * Every setter also resets the page to 1, in the same URL write - otherwise narrowing the filters
 * can leave the caller on a page number the new result set does not reach. Nothing resets it on
 * mount, so a page loaded from the URL stays put.
 *
 * The organization filter used to be inert: the predicate read `selectedOrganization` from
 * OrganizationContext, which nothing in the app ever sets (it is fixed at ['all'], so the
 * predicate always passed), while the dropdown wrote to a separate `selectedOrganizations` state
 * that nothing read. The dropdown's selection now reaches the query.
 */
export const useFeedbackFilters = (): UseFeedbackFiltersReturn => {
  const { value: searchTerm, debouncedValue: debouncedSearchTerm, setValue: setSearchTermValue } = useDebounceValue('');
  const [view, updateView] = useFeedbackView();
  const { statusFilters, organizations: selectedOrganizations, subject, sortAscending, page } = view;

  const setSearchTerm = useCallback(
    (term: string) => {
      setSearchTermValue(term);
      // Skipped when already on page 1, so typing does not rewrite the URL on every keystroke.
      if (page !== 1) updateView({ page: 1 });
    },
    [setSearchTermValue, updateView, page]
  );

  const setStatusFilters = useCallback<UseFeedbackFiltersReturn['setStatusFilters']>(
    update =>
      updateView(current => ({
        statusFilters: typeof update === 'function' ? update(current.statusFilters) : update,
        page: 1,
      })),
    [updateView]
  );

  const setSelectedOrganizations = useCallback(
    (orgs: string[]) => updateView({ organizations: orgs, page: 1 }),
    [updateView]
  );

  const setSubject = useCallback(
    (next: FeedbackSubject | undefined) => updateView({ subject: next, page: 1 }),
    [updateView]
  );

  const toggleSortDirection = useCallback(
    () => updateView(current => ({ sortAscending: !current.sortAscending, page: 1 })),
    [updateView]
  );

  const filters: FeedbackFilters = { searchTerm, statusFilters, selectedOrganizations, subject, sortAscending };

  const filterParams = useMemo<FeedbackListFilterParams>(() => {
    const statuses = Object.values(FeedbackStatus).filter(status => statusFilters[status]);
    return {
      // Omitted rather than sent empty: an empty array would be serialized as no filter anyway,
      // and `status` absent is the server's "any status".
      ...(statuses.length > 0 ? { status: statuses } : {}),
      ...(selectedOrganizations.length > 0 ? { organization: selectedOrganizations } : {}),
      // Single-valued, unlike status/organization: the endpoint takes one subject or none.
      ...(subject ? { subject } : {}),
      ...(debouncedSearchTerm.trim() ? { search: debouncedSearchTerm.trim() } : {}),
      sort: sortAscending ? 'asc' : 'desc',
    };
  }, [statusFilters, selectedOrganizations, subject, debouncedSearchTerm, sortAscending]);

  return {
    filters,
    setSearchTerm,
    setStatusFilters,
    setSelectedOrganizations,
    setSubject,
    toggleSortDirection,
    filterParams,
  };
};
