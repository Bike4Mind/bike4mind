import { describe, it, expect } from 'vitest';
import { classifySource, hostMatchesDomain, sourceHostname } from './sourceFilter';

const levers = (allowedDomains: string[] = [], blockedDomains: string[] = []) => ({
  allowedDomains,
  blockedDomains,
});

describe('sourceHostname', () => {
  it('lowercases the hostname of an http(s) URL', () => {
    expect(sourceHostname('https://Example.COM/a/b?c=d')).toBe('example.com');
    expect(sourceHostname('http://example.com')).toBe('example.com');
  });

  it('refuses a non-http scheme, which the proposal door would refuse anyway', () => {
    expect(sourceHostname('ftp://example.com/x')).toBeNull();
    expect(sourceHostname('file:///etc/passwd')).toBeNull();
    expect(sourceHostname('javascript:alert(1)')).toBeNull();
    expect(sourceHostname('data:text/plain,hello')).toBeNull();
  });

  // `new URL` keeps the root dot, so `evil.com.` would sail past a deny entry of `evil.com`.
  // `normalizeDomainEntry` strips it on the rule side; this is the other half of that pair.
  it('strips a trailing root dot, so a rule written without one still matches', () => {
    expect(sourceHostname('https://evil.com./x')).toBe('evil.com');
  });

  it('returns null rather than throwing on an unparseable URL', () => {
    expect(sourceHostname('not a url')).toBeNull();
    expect(sourceHostname('')).toBeNull();
  });
});

describe('hostMatchesDomain', () => {
  it('matches the domain itself and its subdomains', () => {
    expect(hostMatchesDomain('example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('docs.example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('a.b.example.com', 'example.com')).toBe(true);
  });

  // The reason this is a label-boundary match and not endsWith. A lookalike slipping past a deny
  // list is worse than no deny list.
  it('does not match a lookalike domain that merely ends with the rule', () => {
    expect(hostMatchesDomain('evil-example.com', 'example.com')).toBe(false);
    expect(hostMatchesDomain('notexample.com', 'example.com')).toBe(false);
  });

  it('never matches on an empty rule', () => {
    expect(hostMatchesDomain('example.com', '')).toBe(false);
  });
});

describe('classifySource', () => {
  it('allows anything when neither list is set', () => {
    expect(classifySource('https://example.com/a', levers())).toBe('allowed');
  });

  it('admits only the allow list once one is set', () => {
    const config = levers(['example.com']);
    expect(classifySource('https://docs.example.com/a', config)).toBe('allowed');
    expect(classifySource('https://other.com/a', config)).toBe('not_in_allow_list');
  });

  it('applies deny after allow, so a subdomain can be carved out of an allowed domain', () => {
    const config = levers(['example.com'], ['blog.example.com']);
    expect(classifySource('https://docs.example.com/a', config)).toBe('allowed');
    expect(classifySource('https://blog.example.com/a', config)).toBe('blocked');
  });

  it('blocks a denied domain even with no allow list', () => {
    expect(classifySource('https://spam.net/a', levers([], ['spam.net']))).toBe('blocked');
  });

  it('reports an unusable URL as blocked, so it is dropped before any spend', () => {
    expect(classifySource('ftp://example.com/x', levers())).toBe('blocked');
    expect(classifySource('nonsense', levers())).toBe('blocked');
  });
});
