import { describe, it, expect } from 'vitest';
import { authSuccessRedirectQuery } from './authSuccessRedirect';

describe('authSuccessRedirectQuery', () => {
  it('returns an empty string when there is no redirect target', () => {
    expect(authSuccessRedirectQuery(undefined)).toBe('');
    expect(authSuccessRedirectQuery(null)).toBe('');
    expect(authSuccessRedirectQuery('')).toBe('');
  });

  it('builds an encoded query segment for a simple path', () => {
    expect(authSuccessRedirectQuery('/admin')).toBe('?redirectTo=%2Fadmin');
  });

  it('percent-encodes an embedded query string (the OAuth authorize URL)', () => {
    // Critical case: the value carries ?/&/= AND must not bleed into the
    // #token=... fragment that the callback appends after this segment.
    const authorizeUrl = '/oauth/authorize?client_id=abc&redirect_uri=https://app/cb&state=xyz';
    const segment = authSuccessRedirectQuery(authorizeUrl);

    // No raw delimiters that would break the URL or fragment boundary.
    expect(segment).not.toContain('#');
    expect(segment.indexOf('&')).toBe(-1);
    // Exactly one '?' - the one starting our own query segment.
    expect(segment.match(/\?/g)).toHaveLength(1);

    // Reconstruct the full success URL the callback emits and confirm the value
    // round-trips back to the exact original, fragment intact.
    const fullUrl = `/auth/success${segment}#token=AAA&refreshToken=BBB&userId=123`;
    const parsed = new URL(fullUrl, 'http://localhost');
    expect(parsed.pathname).toBe('/auth/success');
    expect(parsed.searchParams.get('redirectTo')).toBe(authorizeUrl);
    expect(parsed.hash).toBe('#token=AAA&refreshToken=BBB&userId=123');
  });
});
