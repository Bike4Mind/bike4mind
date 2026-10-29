import { describe, expect, it } from 'vitest';
import {
  emailDomainCandidates,
  emailDomainOf,
  isDomainInDomains,
  isEmailInDomains,
  normalizeEmailDomain,
  partitionDomainList,
} from './emailDomain';

describe('normalizeEmailDomain', () => {
  it.each([
    ['kashre.com', 'kashre.com'],
    [' Kashre.COM ', 'kashre.com'],
    ['@kashre.com', 'kashre.com'],
    ['*.kashre.com', 'kashre.com'],
    ['kashre.com.', 'kashre.com'],
    ['np.kashre.co.uk', 'np.kashre.co.uk'],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizeEmailDomain(raw)).toBe(expected);
  });

  it.each(['', 'com', 'kashre', 'x@kashre.com', 'kas hre.com', '-kashre.com', 'kashre..com', 'https://kashre.com'])(
    'rejects %j',
    raw => {
      expect(normalizeEmailDomain(raw)).toBeNull();
    }
  );
});

describe('emailDomainOf', () => {
  it('takes the part after the last @, lowercased and without a trailing dot', () => {
    expect(emailDomainOf('a@b@NP.Kashre.com.')).toBe('np.kashre.com');
  });

  it('reads Unicode full stops as dots and drops repeated trailing dots', () => {
    expect(emailDomainOf('x@kashre\u3002com')).toBe('kashre.com');
    expect(emailDomainOf('x@kashre.com..')).toBe('kashre.com');
  });

  it('is null without an @ or with nothing after it', () => {
    expect(emailDomainOf('notanemail')).toBeNull();
    expect(emailDomainOf('user@')).toBeNull();
  });
});

describe('emailDomainCandidates', () => {
  it('lists the domain then each parent, stopping before the bare TLD', () => {
    expect(emailDomainCandidates('x@a.np.kashre.com')).toEqual(['a.np.kashre.com', 'np.kashre.com', 'kashre.com']);
  });
});

describe('isEmailInDomains', () => {
  const domains = new Set(['kashre.com']);

  it('matches the domain and its subdomains', () => {
    expect(isEmailInDomains('x@kashre.com', domains)).toBe(true);
    expect(isEmailInDomains('x@np.kashre.com', domains)).toBe(true);
  });

  it('does not match a lookalike or a parent', () => {
    expect(isEmailInDomains('x@notkashre.com', domains)).toBe(false);
    expect(isEmailInDomains('x@kashre.com.evil.io', domains)).toBe(false);
    expect(isEmailInDomains('x@com', domains)).toBe(false);
  });
});

describe('isDomainInDomains', () => {
  const domains = new Set(['kashre.com']);

  it('matches the domain itself and its subdomains', () => {
    expect(isDomainInDomains('kashre.com', domains)).toBe(true);
    expect(isDomainInDomains('a.np.kashre.com', domains)).toBe(true);
  });

  it('does not match a parent, a lookalike or a bare TLD', () => {
    expect(isDomainInDomains('np.kashre.com', new Set(['a.np.kashre.com']))).toBe(false);
    expect(isDomainInDomains('notkashre.com', domains)).toBe(false);
    expect(isDomainInDomains('com', new Set(['com']))).toBe(false);
  });
});

describe('partitionDomainList', () => {
  it('normalizes and dedupes valid entries and reports the rest', () => {
    expect(partitionDomainList(['Kashre.com', '@kashre.com', 'xzcoot.com', 'nope', 42])).toEqual({
      valid: ['kashre.com', 'xzcoot.com'],
      invalid: ['nope', '42'],
    });
  });

  it('yields nothing for non-array input', () => {
    expect(partitionDomainList('kashre.com')).toEqual({ valid: [], invalid: [] });
  });
});
