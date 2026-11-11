import { describe, it, expect } from 'vitest';
import { classifySource, hostMatchesDomain, isQueueableVerdict, sourceHostname } from './sourceFilter';

const levers = (
  overrides: Partial<Parameters<typeof classifySource>[1]> = {}
): Parameters<typeof classifySource>[1] => ({
  trustedDomains: [],
  reviewDomains: [],
  blockedDomains: [],
  unlistedSources: 'review',
  ...overrides,
});

// The two-list filter this replaced, expressed on the new fields: an allow list is the review list
// with other sites dropped, and every queueable verdict is what used to be 'allowed'.
const legacy = (allowedDomains: string[] = [], blockedDomains: string[] = []) =>
  levers({
    reviewDomains: allowedDomains,
    blockedDomains,
    unlistedSources: allowedDomains.length > 0 ? 'drop' : 'review',
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
  it('returns each of the four verdicts', () => {
    const config = levers({
      trustedDomains: ['trusted.example'],
      reviewDomains: ['review.example'],
      blockedDomains: ['blocked.example'],
      unlistedSources: 'drop',
    });
    expect(classifySource('https://docs.trusted.example/a', config)).toBe('trusted');
    expect(classifySource('https://review.example/a', config)).toBe('review');
    expect(classifySource('https://blocked.example/a', config)).toBe('blocked');
    expect(classifySource('https://other.example/a', config)).toBe('unlisted_dropped');
  });

  it('sends an unlisted source to review when unlistedSources is review', () => {
    expect(classifySource('https://other.example/a', levers({ trustedDomains: ['trusted.example'] }))).toBe('review');
  });

  describe('precedence', () => {
    it('lets a blocked match win over trusted and review', () => {
      const config = levers({
        trustedDomains: ['example.com'],
        reviewDomains: ['example.com'],
        blockedDomains: ['blog.example.com'],
      });
      expect(classifySource('https://blog.example.com/a', config)).toBe('blocked');
    });

    it('lets a blocked match win even when a trusted entry is more specific', () => {
      const config = levers({ trustedDomains: ['docs.example.com'], blockedDomains: ['example.com'] });
      expect(classifySource('https://docs.example.com/', config)).toBe('blocked');
    });

    it('lets the longest matching entry win across trusted and review', () => {
      const trustedWins = levers({ trustedDomains: ['docs.example.com'], reviewDomains: ['example.com'] });
      expect(classifySource('https://docs.example.com/a', trustedWins)).toBe('trusted');
      expect(classifySource('https://www.example.com/a', trustedWins)).toBe('review');

      const reviewWins = levers({ trustedDomains: ['example.com'], reviewDomains: ['docs.example.com'] });
      expect(classifySource('https://docs.example.com/a', reviewWins)).toBe('review');
      expect(classifySource('https://www.example.com/a', reviewWins)).toBe('trusted');
    });

    it('sends a tie (the same entry in both lists) to review', () => {
      const config = levers({ trustedDomains: ['example.com'], reviewDomains: ['example.com'] });
      expect(classifySource('https://example.com/a', config)).toBe('review');
    });

    it('reports an unparseable or non-http URL as blocked', () => {
      expect(classifySource('ftp://example.com/x', levers())).toBe('blocked');
      expect(classifySource('nonsense', levers())).toBe('blocked');
    });
  });

  // The old two-list filter, replayed on the migrated shape: queueable exactly where it was 'allowed'.
  describe('equivalence with the allow/deny filter', () => {
    const queueable = (url: string, config: ReturnType<typeof legacy>) =>
      isQueueableVerdict(classifySource(url, config));

    it('allows anything when neither list is set', () => {
      expect(queueable('https://example.com/a', legacy())).toBe(true);
    });

    it('admits only the allow list once one is set', () => {
      const config = legacy(['example.com']);
      expect(queueable('https://docs.example.com/a', config)).toBe(true);
      expect(queueable('https://other.com/a', config)).toBe(false);
    });

    it('applies deny after allow, so a subdomain can be carved out of an allowed domain', () => {
      const config = legacy(['example.com'], ['blog.example.com']);
      expect(queueable('https://docs.example.com/a', config)).toBe(true);
      expect(queueable('https://blog.example.com/a', config)).toBe(false);
    });

    it('blocks a denied domain even with no allow list', () => {
      expect(queueable('https://spam.net/a', legacy([], ['spam.net']))).toBe(false);
    });

    it('does not let a lookalike domain through an allow list', () => {
      expect(queueable('https://evil-example.com/a', legacy(['example.com']))).toBe(false);
    });

    it('matches through www. and a trailing root dot', () => {
      expect(queueable('https://www.example.com./a', legacy(['example.com']))).toBe(true);
    });

    it('drops an unparseable URL', () => {
      expect(queueable('nonsense', legacy())).toBe(false);
    });
  });
});

describe('isQueueableVerdict', () => {
  it('admits trusted and review only', () => {
    expect(isQueueableVerdict('trusted')).toBe(true);
    expect(isQueueableVerdict('review')).toBe(true);
    expect(isQueueableVerdict('blocked')).toBe(false);
    expect(isQueueableVerdict('unlisted_dropped')).toBe(false);
  });
});
