import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeRedirectTo,
  buildRedirectTo,
  applyRedirect,
  appendRedirectTo,
  shouldRedirectToConsent,
} from '../authRedirect';

describe('sanitizeRedirectTo', () => {
  it('accepts a simple same-origin path', () => {
    expect(sanitizeRedirectTo('/admin')).toBe('/admin');
  });

  it('preserves an embedded query string', () => {
    expect(sanitizeRedirectTo('/quests?filter=open')).toBe('/quests?filter=open');
  });

  it('preserves a path with both query and hash', () => {
    expect(sanitizeRedirectTo('/projects/123?tab=files#section')).toBe('/projects/123?tab=files#section');
  });

  it('rejects protocol-relative URLs (open-redirect attack vector)', () => {
    expect(sanitizeRedirectTo('//evil.com')).toBeUndefined();
    expect(sanitizeRedirectTo('//evil.com/path')).toBeUndefined();
  });

  it('rejects backslash-prefixed paths (browser normalization attack)', () => {
    expect(sanitizeRedirectTo('/\\evil.com')).toBeUndefined();
  });

  it('rejects absolute URLs', () => {
    expect(sanitizeRedirectTo('https://evil.com')).toBeUndefined();
    expect(sanitizeRedirectTo('http://evil.com')).toBeUndefined();
  });

  it('rejects javascript: scheme', () => {
    expect(sanitizeRedirectTo('javascript:alert(1)')).toBeUndefined();
  });

  it('rejects control characters (CRLF/header-injection vector)', () => {
    expect(sanitizeRedirectTo('/admin\r\nX-Inject: 1')).toBeUndefined();
    expect(sanitizeRedirectTo('/admin\n')).toBeUndefined();
    expect(sanitizeRedirectTo('/admin\x00')).toBeUndefined();
    expect(sanitizeRedirectTo('/admin\x7f')).toBeUndefined();
  });

  it('rejects Unicode line terminators (NEL/LS/PS)', () => {
    expect(sanitizeRedirectTo('/admin\u0085')).toBeUndefined();
    expect(sanitizeRedirectTo('/admin\u2028')).toBeUndefined();
    expect(sanitizeRedirectTo('/admin\u2029')).toBeUndefined();
  });

  it('rejects /login itself to avoid redirect loops', () => {
    expect(sanitizeRedirectTo('/login')).toBeUndefined();
    expect(sanitizeRedirectTo('/login?error=foo')).toBeUndefined();
  });

  it('rejects non-string values', () => {
    expect(sanitizeRedirectTo(undefined)).toBeUndefined();
    expect(sanitizeRedirectTo(null)).toBeUndefined();
    expect(sanitizeRedirectTo(123)).toBeUndefined();
  });

  it('rejects strings too short to be a path', () => {
    expect(sanitizeRedirectTo('')).toBeUndefined();
    expect(sanitizeRedirectTo('/')).toBeUndefined();
  });

  it('rejects strings that do not start with a single slash', () => {
    expect(sanitizeRedirectTo('admin')).toBeUndefined();
    expect(sanitizeRedirectTo(' /admin')).toBeUndefined();
  });
});

describe('buildRedirectTo', () => {
  it('joins pathname and search', () => {
    expect(buildRedirectTo('/admin', '?emergency_access=1')).toBe('/admin?emergency_access=1');
  });

  it('handles pathname with no search', () => {
    expect(buildRedirectTo('/quests')).toBe('/quests');
  });

  it('preserves hash fragments', () => {
    expect(buildRedirectTo('/quests', '', '#section-2')).toBe('/quests#section-2');
    expect(buildRedirectTo('/quests', '?tab=open', '#section-2')).toBe('/quests?tab=open#section-2');
  });

  it('returns undefined for the home page', () => {
    expect(buildRedirectTo('/')).toBeUndefined();
    expect(buildRedirectTo('')).toBeUndefined();
  });

  it('applies sanitization', () => {
    expect(buildRedirectTo('/login')).toBeUndefined();
  });
});

describe('applyRedirect', () => {
  it('pushes the sanitized target', () => {
    const history = { push: vi.fn(), replace: vi.fn() };
    applyRedirect(history, '/admin?foo=bar');
    expect(history.push).toHaveBeenCalledWith('/admin?foo=bar');
    expect(history.replace).not.toHaveBeenCalled();
  });

  it('falls back to /new for unsafe values', () => {
    const history = { push: vi.fn(), replace: vi.fn() };
    applyRedirect(history, '//evil.com');
    expect(history.push).toHaveBeenCalledWith('/new');
  });

  it('falls back to /new when missing', () => {
    const history = { push: vi.fn(), replace: vi.fn() };
    applyRedirect(history, null);
    expect(history.push).toHaveBeenCalledWith('/new');
  });

  it('honors a custom fallback', () => {
    const history = { push: vi.fn(), replace: vi.fn() };
    applyRedirect(history, undefined, '/dashboard');
    expect(history.push).toHaveBeenCalledWith('/dashboard');
  });

  it('uses replace when the replace flag is true', () => {
    const history = { push: vi.fn(), replace: vi.fn() };
    applyRedirect(history, '/admin', '/new', true);
    expect(history.replace).toHaveBeenCalledWith('/admin');
    expect(history.push).not.toHaveBeenCalled();
  });

  it('loads a published-page path as a full document rather than an SPA route', () => {
    const location = { assign: vi.fn(), replace: vi.fn() };
    vi.stubGlobal('location', location);
    try {
      const history = { push: vi.fn(), replace: vi.fn() };
      applyRedirect(history, '/p/r/abc123');
      applyRedirect(history, '/a/token', '/new', true);
      expect(location.assign).toHaveBeenCalledWith('/p/r/abc123');
      expect(location.replace).toHaveBeenCalledWith('/a/token');
      expect(history.push).not.toHaveBeenCalled();
      expect(history.replace).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('replaces with the fallback when value is unsafe and replace is true', () => {
    const history = { push: vi.fn(), replace: vi.fn() };
    applyRedirect(history, '//evil.com', '/new', true);
    expect(history.replace).toHaveBeenCalledWith('/new');
    expect(history.push).not.toHaveBeenCalled();
  });
});

describe('appendRedirectTo', () => {
  it('returns the URL unchanged when redirectTo is missing', () => {
    expect(appendRedirectTo('/api/auth/google', null)).toBe('/api/auth/google');
    expect(appendRedirectTo('/api/auth/google', undefined)).toBe('/api/auth/google');
    expect(appendRedirectTo('/api/auth/google', '')).toBe('/api/auth/google');
  });

  it('appends redirectTo to a provider URL with no existing query (google/github)', () => {
    expect(appendRedirectTo('/api/auth/google', '/admin')).toBe('/api/auth/google?redirectTo=%2Fadmin');
  });

  it('merges redirectTo into a provider URL that already has a query (okta/saml ?idp=)', () => {
    const result = appendRedirectTo('/api/auth/okta?idp=abc123', '/admin');
    const search = new URLSearchParams(result.split('?')[1]);
    expect(result.startsWith('/api/auth/okta?')).toBe(true);
    expect(search.get('idp')).toBe('abc123');
    expect(search.get('redirectTo')).toBe('/admin');
  });

  it('preserves an embedded query string in redirectTo (the OAuth authorize URL)', () => {
    // Critical case: redirectTo itself carries ?/&/= that must survive the
    // round-trip - encoded on the way out, decoded back to the exact original.
    const authorizeUrl = '/oauth/authorize?client_id=abc&redirect_uri=https://app/cb&state=xyz';
    const result = appendRedirectTo('/api/auth/google', authorizeUrl);
    // The whole value is a single, opaque, percent-encoded query param...
    expect(result).toBe(`/api/auth/google?redirectTo=${encodeURIComponent(authorizeUrl)}`);
    // ...and decodes back to the exact original path+query.
    expect(new URLSearchParams(result.split('?').slice(1).join('?')).get('redirectTo')).toBe(authorizeUrl);
  });

  it('keeps the result relative — never leaks the dummy parse base into the output', () => {
    const result = appendRedirectTo('/api/auth/github', '/projects/123?tab=files');
    expect(result.startsWith('/api/auth/github')).toBe(true);
    expect(result).not.toContain('localhost');
    expect(result).not.toContain('http');
  });

  it('overwrites a pre-existing redirectTo on the target rather than duplicating it', () => {
    const result = appendRedirectTo('/api/auth/google?redirectTo=/stale', '/fresh');
    const search = new URLSearchParams(result.split('?')[1]);
    expect(search.getAll('redirectTo')).toEqual(['/fresh']);
  });
});

describe('shouldRedirectToConsent', () => {
  const TOKEN = 'live-access-token';

  it('redirects a server-confirmed user with a live session who has not accepted policies', () => {
    // Genuine target: after login, identify sets the user (isHydrated true) with a live token and
    // no aupAcceptedVersion. The guard must fire.
    expect(shouldRedirectToConsent({ currentUser: {}, isHydrated: true, accessToken: TOKEN })).toBe(true);
    expect(
      shouldRedirectToConsent({ currentUser: { aupAcceptedVersion: undefined }, isHydrated: true, accessToken: TOKEN })
    ).toBe(true);
  });

  it('does NOT redirect a rehydrated pre-deploy user before identify lands (the bug)', () => {
    // A session already logged in when the consent feature shipped rehydrates from a persisted
    // stub that lacks aupAcceptedVersion; isHydrated is still false until /api/identify writes the
    // server-authoritative (grandfathered) value. The guard must defer, not flash the interstitial.
    expect(shouldRedirectToConsent({ currentUser: {}, isHydrated: false, accessToken: TOKEN })).toBe(false);
    expect(
      shouldRedirectToConsent({ currentUser: { aupAcceptedVersion: undefined }, isHydrated: false, accessToken: TOKEN })
    ).toBe(false);
  });

  it('does NOT redirect a token-less / broken session - it goes to /login instead (issue #386)', () => {
    // The deadlock fix: a stale persisted currentUser with no live access token must NOT be sent to
    // /accept-policies (which can't record acceptance for it and bounces to /login), else the user
    // is trapped in a /login <-> /accept-policies loop.
    expect(shouldRedirectToConsent({ currentUser: {}, isHydrated: true, accessToken: null })).toBe(false);
    expect(
      shouldRedirectToConsent({ currentUser: { aupAcceptedVersion: undefined }, isHydrated: true, accessToken: null })
    ).toBe(false);
    expect(shouldRedirectToConsent({ currentUser: {}, isHydrated: true, accessToken: '' })).toBe(false);
  });

  it('does NOT redirect a user who has already accepted, hydrated or not', () => {
    expect(
      shouldRedirectToConsent({ currentUser: { aupAcceptedVersion: 'v1' }, isHydrated: true, accessToken: TOKEN })
    ).toBe(false);
    expect(
      shouldRedirectToConsent({
        currentUser: { aupAcceptedVersion: 'grandfathered' },
        isHydrated: false,
        accessToken: TOKEN,
      })
    ).toBe(false);
  });

  it('does NOT redirect when there is no user (that path bounces to /login instead)', () => {
    expect(shouldRedirectToConsent({ currentUser: null, isHydrated: true, accessToken: TOKEN })).toBe(false);
    expect(shouldRedirectToConsent({ currentUser: null, isHydrated: false, accessToken: null })).toBe(false);
  });
});
