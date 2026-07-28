import { describe, it, expect } from 'vitest';
import { buildUserActivityRequest } from './userActivityRequest';
import { ALL_VALUE } from './store';

/**
 * The grid and the CSV export must ask the server the same question. Two hand-rolled copies
 * of this mapping would drift, and the export would quietly disagree with what is on screen.
 */
const state = {
  dateFilters: { startDate: '2026-07-21', endDate: '2026-07-28' },
  selectedOrganizations: [ALL_VALUE],
  excludedOrgs: { millionOnMars: true, unknown: false, personal: true },
  userActivityFilters: { counterNameSearch: '', userEmailSearch: '' },
  metadataFilters: [],
};

describe('buildUserActivityRequest', () => {
  it('maps the exclusion checkboxes to the organization names the server stores', () => {
    expect(buildUserActivityRequest(state).excludeOrgs).toEqual(['Million on Mars', 'Personal']);
  });

  it('drops the exclusions once a specific organization is selected', () => {
    const request = buildUserActivityRequest({ ...state, selectedOrganizations: ['Acme'] });

    expect(request.excludeOrgs).toEqual([]);
    expect(request.orgs).toEqual(['Acme']);
  });

  it('sends no organization list while "all" is selected', () => {
    expect(buildUserActivityRequest(state).orgs).toBeNull();
  });

  it('omits blank searches so the server does not filter on an empty string', () => {
    const request = buildUserActivityRequest(state);

    expect(request.counterName).toBeUndefined();
    expect(request.userEmail).toBeUndefined();
  });

  it('passes the searches through when set', () => {
    const request = buildUserActivityRequest({
      ...state,
      userActivityFilters: { counterNameSearch: 'Login', userEmailSearch: 'poy@' },
    });

    expect(request).toMatchObject({ counterName: 'Login', userEmail: 'poy@' });
  });

  it('omits an empty metadata filter list', () => {
    expect(buildUserActivityRequest(state).metadataFilters).toBeUndefined();
  });
});
