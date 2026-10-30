import { describe, it, expect, beforeEach } from 'vitest';
import { useAnalyticsStore, ALL_VALUE } from './store';
import { DEFAULT_PRESET_DAYS, getPresetRange } from './dateRange';

/**
 * Paging moved to the server, so the page number is part of the query. Any filter change
 * reshapes the result set - keeping the old page would request a page that may no longer
 * exist and render an empty grid over a non-empty result.
 */
const page = () => useAnalyticsStore.getState().page;
const onPage = (n: number) => useAnalyticsStore.getState().setPage(n);

describe('analytics store - page reset', () => {
  beforeEach(() => {
    useAnalyticsStore.setState({
      page: 1,
      limit: 25,
      selectedOrganizations: [ALL_VALUE],
      metadataFilters: [],
      userActivityFilters: { counterNameSearch: '', userEmailSearch: '' },
    });
  });

  it('starts on the first page', () => {
    expect(page()).toBe(1);
  });

  it('moves to the requested page', () => {
    onPage(4);
    expect(page()).toBe(4);
  });

  it('returns to the first page when the date range changes', () => {
    onPage(4);
    useAnalyticsStore.getState().setDateFilters({ startDate: '2026-07-01', endDate: '2026-07-02' });
    expect(page()).toBe(1);
  });

  it('returns to the first page when a search term changes', () => {
    onPage(4);
    useAnalyticsStore.getState().setUserActivityFilters({ counterNameSearch: 'Login' });
    expect(page()).toBe(1);
  });

  it('returns to the first page when an exclusion is toggled', () => {
    onPage(4);
    useAnalyticsStore.getState().toggleExclusion('staff');
    expect(page()).toBe(1);
  });

  it('returns to the first page when the organization selection changes', () => {
    onPage(4);
    useAnalyticsStore.getState().setSelectedOrganizations(['Acme']);
    expect(page()).toBe(1);
  });

  it('falls back to "All" when the last organization is deselected', () => {
    useAnalyticsStore.getState().setSelectedOrganizations(['Acme']);
    useAnalyticsStore.getState().setSelectedOrganizations([]);
    expect(useAnalyticsStore.getState().selectedOrganizations).toEqual([ALL_VALUE]);
  });

  it('returns to the first page when metadata filters change', () => {
    onPage(4);
    useAnalyticsStore.getState().setMetadataFilters([{ field: 'source', operator: 'exists' }]);
    expect(page()).toBe(1);
  });

  it('returns to the first page when the page size changes', () => {
    onPage(4);
    useAnalyticsStore.getState().setLimit(50);
    expect(page()).toBe(1);
    expect(useAnalyticsStore.getState().limit).toBe(50);
  });
});

describe('analytics store - default date range', () => {
  it('re-anchors an untouched default range to today', () => {
    useAnalyticsStore.setState({
      isDefaultDateRange: true,
      dateFilters: { startDate: '2020-01-01', endDate: '2020-01-07' },
      page: 3,
    });

    useAnalyticsStore.getState().refreshDefaultDateFilters();

    expect(useAnalyticsStore.getState().dateFilters).toEqual(getPresetRange(DEFAULT_PRESET_DAYS));
    expect(page()).toBe(1);
  });

  it('keeps a range the user picked', () => {
    const picked = { startDate: '2020-01-01', endDate: '2020-01-07' };
    useAnalyticsStore.getState().setDateFilters(picked);

    useAnalyticsStore.getState().refreshDefaultDateFilters();

    expect(useAnalyticsStore.getState().dateFilters).toEqual(picked);
  });
});
