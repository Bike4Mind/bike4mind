import { describe, expect, it } from 'vitest';
import { redactShareTokenPath, requestLogUrl } from './requestLogUrl';

describe('search request log URLs', () => {
  it.each(['b4m_live_' + 'a'.repeat(32), '192.0.2.1', 'person@example.com'])('redacts %s', identifier => {
    expect(requestLogUrl(`/api/admin/search?q=${encodeURIComponent(identifier)}`)).toBe('/api/admin/search');
  });
  it('preserves other request paths', () => {
    expect(requestLogUrl('/api/admin/users?limit=10')).toBe('/api/admin/users?limit=10');
  });
});

describe('share-link token paths', () => {
  const token = 'synthetic-share-token-0123456789';

  it.each([
    [`/a/${token}`, '/a/[redacted]'],
    [`/a/${token}/assets/x.js?download=1`, '/a/[redacted]/assets/x.js?download=1'],
    [`/a/${token}?download=1`, '/a/[redacted]?download=1'],
    [`/api/publish/serve/a/${token}`, '/api/publish/serve/a/[redacted]'],
    [`/api/publish/serve/a/${token}/index.html`, '/api/publish/serve/a/[redacted]/index.html'],
    [`/a/${encodeURIComponent(`${token}/x`)}`, '/a/[redacted]'],
    [`//a//${token}/x`, '//a//[redacted]/x'],
  ])('redacts the token in %s', (url, expected) => {
    expect(requestLogUrl(url)).toBe(expected);
    expect(redactShareTokenPath(url)).not.toContain(token);
  });

  it.each([
    '/a',
    '/a/',
    '/a/?x=1',
    '/ab/x',
    '/api/publish/serve/a',
    '/api/publish/serve/ab/x',
    '/p/x',
    '/embed/x',
    '/api/a/x',
  ])('leaves %s unchanged', url => {
    expect(requestLogUrl(url)).toBe(url);
  });
});
