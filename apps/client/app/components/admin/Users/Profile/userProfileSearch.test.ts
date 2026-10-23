import { describe, expect, it } from 'vitest';
import { legacyUserLinkRedirect, parseUserProfileSearch } from './userProfileSearch';

describe('parseUserProfileSearch', () => {
  it.each(['activity', 'admin'] as const)('keeps a deep link to the %s tab', tab => {
    expect(parseUserProfileSearch({ tab })).toEqual({ tab });
  });

  it('drops the default tab so links stay short', () => {
    expect(parseUserProfileSearch({ tab: 'overview' })).toEqual({});
  });

  it('drops an unknown tab rather than opening an empty panel', () => {
    expect(parseUserProfileSearch({ tab: 'billing' })).toEqual({});
    expect(parseUserProfileSearch({ tab: 3 })).toEqual({});
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
