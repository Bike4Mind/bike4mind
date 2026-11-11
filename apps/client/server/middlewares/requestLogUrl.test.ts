import { describe, expect, it } from 'vitest';
import { redactTokenPath, requestLogUrl } from './requestLogUrl';

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
    [`/p/a/${token}`, '/p/a/[redacted]'],
    [`/uc/a/${token}/index.html?__uc=1`, '/uc/a/[redacted]/index.html?__uc=1'],
    [`/api/publish/serve/%61/${token}`, '/api/publish/serve/%61/[redacted]'],
    [`/%61/${token}`, '/%61/[redacted]'],
    [`/p/%61/${token}`, '/p/%61/[redacted]'],
    [`/A/${token}`, '/A/[redacted]'],
    [`/a/${token}%zz/x`, '/a/[redacted]/x'],
    [`/a/${token}/..%2fx`, '/a/[redacted]/..%2fx'],
  ])('redacts the token in %s', (url, expected) => {
    expect(requestLogUrl(url)).toBe(expected);
    expect(redactTokenPath(url)).not.toContain(token);
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
    '/p/a',
    '/p/x/a/y',
    '/uc/ab/x',
  ])('leaves %s unchanged', url => {
    expect(requestLogUrl(url)).toBe(url);
  });
});

describe('by-design path-token routes', () => {
  const token = 'synthetic-path-token-0123456789ab';

  it.each([
    [`/api/admin/qa/report/run-1/${token}/index.html`, '/api/admin/qa/report/run-1/[redacted]/index.html'],
    [`/api/admin/qa/report/run-1/${token}/assets/app.css`, '/api/admin/qa/report/run-1/[redacted]/assets/app.css'],
    [`/api/skills/market/by-token/${token}`, '/api/skills/market/by-token/[redacted]'],
    [`/api/file-links/${token}`, '/api/file-links/[redacted]'],
    [`/api/file-links/${token}?download=1`, '/api/file-links/[redacted]?download=1'],
    [`/api/webhooks/github/${token}`, '/api/webhooks/github/[redacted]'],
    [`/api/webhooks/jira/${token}`, '/api/webhooks/jira/[redacted]'],
    [`/API/File-Links/${token}`, '/API/File-Links/[redacted]'],
  ])('redacts the token in %s', (url, expected) => {
    expect(requestLogUrl(url)).toBe(expected);
    expect(redactTokenPath(url)).not.toContain(token);
  });

  it.each([
    '/api/admin/qa/report/run-1',
    '/api/admin/qa/runs',
    '/api/skills/market/by-token',
    '/api/skills/market/l1',
    '/api/file-links',
    '/api/webhooks/github',
    '/api/webhooks/github/lake',
    '/api/webhooks/github/sre',
    '/api/webhooks/github/subscriptions',
    '/api/webhooks/github/subscriptions/s1',
    '/api/webhooks/jira/config',
    '/api/webhooks/jira/subscriptions/s1',
  ])('leaves %s unchanged', url => {
    expect(requestLogUrl(url)).toBe(url);
  });
});
