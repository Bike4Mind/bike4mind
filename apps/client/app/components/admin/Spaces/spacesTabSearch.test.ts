import { describe, expect, it } from 'vitest';
import {
  adminSpaceHref,
  DEFAULT_SPACES_VIEW,
  SPACES_SEARCH_PARSERS,
  spacesViewFromSearch,
  spacesViewToSearch,
} from './spacesTabSearch';

describe('spacesTabSearch', () => {
  it('falls back to defaults for missing or invalid params', () => {
    expect(spacesViewFromSearch({})).toEqual(DEFAULT_SPACES_VIEW);
    expect(spacesViewFromSearch({ spacesPage: '-3', spacesLimit: '7', spacesSort: 'bogus' })).toEqual(
      DEFAULT_SPACES_VIEW
    );
  });

  it('round-trips a non-default view and leaves defaults out of the URL', () => {
    const view = { page: 3, limit: 50, sort: 'name' as const };
    expect(spacesViewFromSearch(spacesViewToSearch(view))).toEqual(view);
    expect(spacesViewToSearch(DEFAULT_SPACES_VIEW)).toEqual({
      spacesPage: undefined,
      spacesLimit: undefined,
      spacesSort: undefined,
    });
  });

  it('has no param for the search text', () => {
    expect(Object.keys(SPACES_SEARCH_PARSERS)).not.toContain('spacesSearch');
  });

  it('builds a link that opens one Space', () => {
    expect(adminSpaceHref('650000000000000000000aaa')).toBe('/admin?tab=spaces&spaceId=650000000000000000000aaa');
  });
});
