import { describe, expect, it } from 'vitest';
import { legacyUserLinkRedirect, parseUserProfileSearch, userProfileTabSearch } from './userProfileSearch';

describe('parseUserProfileSearch', () => {
  it.each(['activity', 'credits', 'billing', 'keys', 'signins', 'admin'] as const)(
    'keeps a deep link to the %s tab',
    tab => {
      expect(parseUserProfileSearch({ tab })).toEqual({ tab });
    }
  );

  // The router spreads the validated search over the raw parent search, so assert on that merge.
  const routeSearch = (raw: Record<string, unknown>) => ({ ...raw, ...parseUserProfileSearch(raw) });

  it('drops the default tab so links stay short', () => {
    expect(routeSearch({ tab: 'overview' }).tab).toBeUndefined();
  });

  it.each(['nonsense', 'Activity', '', 3])('drops the unknown tab %j rather than opening an empty panel', tab => {
    expect(routeSearch({ tab }).tab).toBeUndefined();
  });

  it('preserves valid classification context and rejects malformed range or timestamp values', () => {
    expect(parseUserProfileSearch({ signupRange: '30d', signupAsOf: '2026-11-01T12:00:00.000Z' })).toMatchObject({
      signupRange: '30d',
      signupAsOf: '2026-11-01T12:00:00.000Z',
    });
    expect(routeSearch({ signupRange: 'nonsense', signupAsOf: 'not-a-date' })).toMatchObject({
      signupRange: undefined,
      signupAsOf: undefined,
    });
  });

  it('retains classification context across profile tabs while dropping Activity filters on Overview', () => {
    const context = { signupRange: '30d' as const, signupAsOf: '2026-11-01T12:00:00.000Z', signupTzOffset: 480 };
    const signins = userProfileTabSearch(context, 'signins');
    const overview = userProfileTabSearch({ ...signins, from: '2026-11-01' }, 'overview');
    expect(signins).toMatchObject({ ...context, tab: 'signins' });
    expect(overview).toMatchObject({ ...context, tab: undefined, from: undefined });
  });

  it('keeps a shareable billing window on the Billing tab only, leaving the default out', () => {
    expect(routeSearch({ tab: 'billing', range: '365d' })).toMatchObject({ tab: 'billing', range: '365d' });
    expect(routeSearch({ tab: 'billing', range: '90d' }).range).toBeUndefined();
    expect(routeSearch({ tab: 'billing', range: '7d' }).range).toBeUndefined();
    expect(routeSearch({ tab: 'credits', range: '365d' }).range).toBeUndefined();
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
