import { describe, it, expect } from 'vitest';
import { resolveCrossTabRedirect, resolveStorageEventRedirect } from './crossTabLogout';
import { ACCESS_TOKEN_STORAGE_KEY } from '@client/app/hooks/useAccessToken';

const loc = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });
const payload = (state: Record<string, unknown>) => JSON.stringify({ state });

describe('resolveCrossTabRedirect', () => {
  it('redirects to a plain /login when the key was removed entirely (null newValue)', () => {
    expect(resolveCrossTabRedirect(null, loc('/new'))).toBe('/login');
  });

  it('returns null when the other tab still holds an accessToken (cross-tab refresh)', () => {
    // A token refresh in another tab rewrites the entry with a fresh accessToken -
    // this tab is still authenticated, so it must NOT bounce to /login.
    expect(resolveCrossTabRedirect(payload({ accessToken: 'fresh', expired: false }), loc('/new'))).toBeNull();
  });

  it('surfaces session_expired with redirectTo on a refresh-failure expiry', () => {
    const url = resolveCrossTabRedirect(
      payload({ accessToken: null, expired: true, expiredReason: 'expired' }),
      loc('/projects', '?a=1', '#x')
    );
    expect(url).toBe(`/login?error=session_expired&redirectTo=${encodeURIComponent('/projects?a=1#x')}`);
  });

  it('surfaces session_revoked for a security-forced logout (MFA lockout)', () => {
    const url = resolveCrossTabRedirect(
      payload({ accessToken: null, expired: true, expiredReason: 'revoked' }),
      loc('/new')
    );
    expect(url).toBe(`/login?error=session_revoked&redirectTo=${encodeURIComponent('/new')}`);
  });

  it('does nothing (returns null) on a public path, matching the in-tab interceptor', () => {
    // A background tab mid-login / register / password-reset must not be yanked to /login
    // by another tab's session change - that would wipe an in-progress form.
    expect(
      resolveCrossTabRedirect(payload({ accessToken: null, expired: true, expiredReason: 'expired' }), loc('/login'))
    ).toBeNull();
    expect(
      resolveCrossTabRedirect(payload({ accessToken: null, expired: true, expiredReason: 'revoked' }), loc('/register'))
    ).toBeNull();
    // even a plain removed-key logout is a no-op on a public path
    expect(resolveCrossTabRedirect(null, loc('/login'))).toBeNull();
  });

  it('uses a plain /login for a voluntary logout (expired: false)', () => {
    expect(resolveCrossTabRedirect(payload({ accessToken: null, expired: false }), loc('/new'))).toBe('/login');
  });

  it('uses a plain /login when expired is true but the reason is unknown', () => {
    expect(resolveCrossTabRedirect(payload({ accessToken: null, expired: true }), loc('/new'))).toBe('/login');
  });

  it('treats malformed JSON as a plain logout', () => {
    expect(resolveCrossTabRedirect('{not valid json', loc('/new'))).toBe('/login');
  });
});

describe('resolveStorageEventRedirect', () => {
  const cleared = payload({ accessToken: null, expired: true, expiredReason: 'expired' });

  it('ignores storage events for any other localStorage key', () => {
    // Same payload that WOULD redirect, but under an unrelated key - must be a no-op.
    expect(resolveStorageEventRedirect({ key: 'some-other-key', newValue: cleared }, loc('/new'))).toBeNull();
    expect(resolveStorageEventRedirect({ key: null, newValue: cleared }, loc('/new'))).toBeNull();
  });

  it('delegates to resolveCrossTabRedirect for the access-token key', () => {
    expect(resolveStorageEventRedirect({ key: ACCESS_TOKEN_STORAGE_KEY, newValue: cleared }, loc('/new'))).toBe(
      `/login?error=session_expired&redirectTo=${encodeURIComponent('/new')}`
    );
  });

  it('returns null for the access-token key when a token is still present (delegated no-op)', () => {
    expect(
      resolveStorageEventRedirect(
        { key: ACCESS_TOKEN_STORAGE_KEY, newValue: payload({ accessToken: 'fresh' }) },
        loc('/new')
      )
    ).toBeNull();
  });
});
