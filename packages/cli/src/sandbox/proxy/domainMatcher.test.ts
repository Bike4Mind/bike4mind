import { describe, it, expect } from 'vitest';
import { normalizeDomain, matchesDomain, isDomainAllowed } from './domainMatcher.js';

describe('domainMatcher', () => {
  describe('normalizeDomain', () => {
    it('lowercases the domain', () => {
      expect(normalizeDomain('GitHub.COM')).toBe('github.com');
    });

    it('strips trailing dot', () => {
      expect(normalizeDomain('github.com.')).toBe('github.com');
    });

    it('strips port', () => {
      expect(normalizeDomain('github.com:443')).toBe('github.com');
    });

    it('strips port and trailing dot', () => {
      expect(normalizeDomain('GitHub.COM.:443')).toBe('github.com');
    });

    it('handles empty string', () => {
      expect(normalizeDomain('')).toBe('');
    });

    it('trims whitespace', () => {
      expect(normalizeDomain('  github.com  ')).toBe('github.com');
    });

    it('preserves IPv6 brackets', () => {
      expect(normalizeDomain('[::1]')).toBe('[::1]');
    });
  });

  describe('matchesDomain', () => {
    it('matches exact domain', () => {
      expect(matchesDomain('github.com', 'github.com')).toBe(true);
    });

    it('matches exact domain case-insensitively', () => {
      expect(matchesDomain('GitHub.COM', 'github.com')).toBe(true);
    });

    it('matches wildcard subdomain', () => {
      expect(matchesDomain('api.github.com', '*.github.com')).toBe(true);
    });

    it('matches nested subdomain with wildcard', () => {
      expect(matchesDomain('foo.bar.github.com', '*.github.com')).toBe(true);
    });

    it('wildcard does NOT match bare domain', () => {
      expect(matchesDomain('github.com', '*.github.com')).toBe(false);
    });

    it('does not match unrelated domain', () => {
      expect(matchesDomain('evil.com', 'github.com')).toBe(false);
    });

    it('does not match partial suffix', () => {
      expect(matchesDomain('notgithub.com', '*.github.com')).toBe(false);
    });

    it('matches with port stripping', () => {
      expect(matchesDomain('github.com:443', 'github.com')).toBe(true);
    });

    it('matches wildcard with port stripping', () => {
      expect(matchesDomain('api.github.com:8080', '*.github.com')).toBe(true);
    });
  });

  describe('isDomainAllowed', () => {
    const allowedDomains = ['registry.npmjs.org', '*.npmjs.org', 'github.com', '*.github.com'];

    it('allows exact match', () => {
      expect(isDomainAllowed('github.com', allowedDomains)).toBe(true);
    });

    it('allows wildcard match', () => {
      expect(isDomainAllowed('api.github.com', allowedDomains)).toBe(true);
    });

    it('allows registry subdomain via wildcard', () => {
      expect(isDomainAllowed('registry.npmjs.org', allowedDomains)).toBe(true);
    });

    it('blocks domain not in list', () => {
      expect(isDomainAllowed('evil.com', allowedDomains)).toBe(false);
    });

    it('returns false for empty domain', () => {
      expect(isDomainAllowed('', allowedDomains)).toBe(false);
    });

    it('returns false for empty allowlist', () => {
      expect(isDomainAllowed('github.com', [])).toBe(false);
    });

    it('handles domain with port', () => {
      expect(isDomainAllowed('github.com:443', allowedDomains)).toBe(true);
    });

    it('handles case insensitivity', () => {
      expect(isDomainAllowed('GITHUB.COM', allowedDomains)).toBe(true);
    });
  });
});
