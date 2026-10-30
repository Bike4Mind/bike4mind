import { describe, expect, it } from 'vitest';
import { legacyUserLinkRedirect, parseUserProfileSearch } from './userProfileSearch';

describe('parseUserProfileSearch', () => {
  it.each(['activity', 'credits', 'keys', 'signins', 'admin'] as const)('keeps a deep link to the %s tab', tab => {
    expect(parseUserProfileSearch({ tab })).toEqual({ tab });
  });

  // The router spreads the validated search over the raw parent search, so assert on that merge.
  const routeSearch = (raw: Record<string, unknown>) => ({ ...raw, ...parseUserProfileSearch(raw) });

  it('drops the default tab so links stay short', () => {
    expect(routeSearch({ tab: 'overview' }).tab).toBeUndefined();
  });

  it.each(['nonsense', 'Activity', '', 3])('drops the unknown tab %j rather than opening an empty panel', tab => {
    expect(routeSearch({ tab }).tab).toBeUndefined();
  });
});

describe('legacyUserLinkRedirect', () => {
  it('sends an old ?userId= link to the profile route, replacing the history entry', () => {
    expect(legacyUserLinkRedirect({ userId: '0123456789abcdef01234567' })).toEqual({
      to: '/admin/users/$userId',
      params: { userId: '0123456789abcdef01234567' },
      replace: true,
    });
  });

  it('leaves /admin alone when there is no user in the URL', () => {
    expect(legacyUserLinkRedirect({})).toBeUndefined();
  });
});
