import { describe, it, expect } from 'vitest';
import {
  deriveLegacyAllowedDomains,
  isSameDomainSet,
  normalizeDomainEntry,
  upgradeLegacyResearchLevers,
} from './researchSourceTiers';
import type { LegacyResearchRunLevers } from '../types/entities/DataLakeResearchTypes';

const base: LegacyResearchRunLevers = {
  query: 'q',
  maxResults: 10,
  maxProposals: 5,
  blockedDomains: ['bad.example'],
  minRelevance: 0.5,
  costCeilingMicroUsd: 1000,
  proposedTags: [],
};

describe('deriveLegacyAllowedDomains', () => {
  it('is the trusted plus review union under drop, and empty under review', () => {
    const tiers = { trustedDomains: ['t.com', 'x.com'], reviewDomains: ['r.com', 'x.com'] };
    expect(deriveLegacyAllowedDomains({ ...tiers, unlistedSources: 'drop' })).toEqual(['t.com', 'x.com', 'r.com']);
    expect(deriveLegacyAllowedDomains({ ...tiers, unlistedSources: 'review' })).toEqual([]);
  });
});

describe('isSameDomainSet', () => {
  it('ignores order and duplicates', () => {
    expect(isSameDomainSet(['a', 'b'], ['b', 'a', 'a'])).toBe(true);
    expect(isSameDomainSet(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('normalizeDomainEntry', () => {
  it('reduces a pasted URL to a hostname and keeps www. on a bare TLD', () => {
    expect(normalizeDomainEntry('https://www.Example.com/x')).toBe('example.com');
    expect(normalizeDomainEntry('www.com')).toBe('www.com');
    expect(normalizeDomainEntry('https://')).toBe('');
  });
});

describe('upgradeLegacyResearchLevers - legacy mapping', () => {
  it('maps a non-empty allowedDomains to the review list with other sites dropped', () => {
    expect(upgradeLegacyResearchLevers({ ...base, allowedDomains: ['a.com'] })).toMatchObject({
      trustedDomains: [],
      reviewDomains: ['a.com'],
      unlistedSources: 'drop',
      blockedDomains: ['bad.example'],
      allowedDomains: ['a.com'],
    });
  });

  it('maps an empty allowedDomains to other sites going to review', () => {
    expect(upgradeLegacyResearchLevers({ ...base, allowedDomains: [] })).toMatchObject({
      trustedDomains: [],
      reviewDomains: [],
      unlistedSources: 'review',
      allowedDomains: [],
    });
  });

  it('maps an absent allowedDomains to other sites going to review', () => {
    expect(upgradeLegacyResearchLevers(base)).toMatchObject({ reviewDomains: [], unlistedSources: 'review' });
  });

  it('keeps blockedDomains unchanged', () => {
    expect(upgradeLegacyResearchLevers({ ...base, allowedDomains: ['a.com'] }).blockedDomains).toEqual(['bad.example']);
  });

  it('converts a hydrated empty reviewDomains next to a non-empty allowedDomains', () => {
    const upgraded = upgradeLegacyResearchLevers({
      ...base,
      reviewDomains: [],
      trustedDomains: [],
      allowedDomains: ['a.com'],
    });
    expect(upgraded).toMatchObject({ reviewDomains: ['a.com'], unlistedSources: 'drop' });
  });

  it('treats an invalid unlistedSources as legacy', () => {
    const upgraded = upgradeLegacyResearchLevers({
      ...base,
      allowedDomains: ['a.com'],
      unlistedSources: 'bogus' as unknown as 'drop',
    });
    expect(upgraded).toMatchObject({ reviewDomains: ['a.com'], unlistedSources: 'drop' });
  });
});

describe('upgradeLegacyResearchLevers - mismatch rule', () => {
  const tiered: LegacyResearchRunLevers = {
    ...base,
    trustedDomains: ['t.com'],
    reviewDomains: ['r.com'],
    unlistedSources: 'drop',
    allowedDomains: ['t.com', 'r.com'],
  };

  it('is a no-op when allowedDomains matches the derive', () => {
    expect(upgradeLegacyResearchLevers({ ...tiered, allowedDomains: ['r.com', 't.com'] })).toMatchObject({
      trustedDomains: ['t.com'],
      reviewDomains: ['r.com'],
      unlistedSources: 'drop',
    });
  });

  it('converts a different non-empty value to the review list under drop, preserving trusted', () => {
    expect(upgradeLegacyResearchLevers({ ...tiered, allowedDomains: ['old.com'] })).toMatchObject({
      trustedDomains: ['t.com'],
      reviewDomains: ['old.com'],
      unlistedSources: 'drop',
    });
  });

  it('converts an emptied value to review mode and keeps the stored review list', () => {
    expect(upgradeLegacyResearchLevers({ ...tiered, allowedDomains: [] })).toMatchObject({
      trustedDomains: ['t.com'],
      reviewDomains: ['r.com'],
      unlistedSources: 'review',
      allowedDomains: [],
    });
  });

  it('is idempotent', () => {
    const once = upgradeLegacyResearchLevers({ ...tiered, allowedDomains: ['old.com'] });
    expect(upgradeLegacyResearchLevers(once)).toEqual(once);
  });
});

describe('upgradeLegacyResearchLevers auto-admit defaults', () => {
  it('reads absent levers as off with the default cap', () => {
    expect(upgradeLegacyResearchLevers(base)).toMatchObject({ autoAdmitTrusted: false, maxAutoAdmits: 3 });
    expect(upgradeLegacyResearchLevers({ ...base, allowedDomains: ['a.com'] })).toMatchObject({
      autoAdmitTrusted: false,
      maxAutoAdmits: 3,
    });
    expect(upgradeLegacyResearchLevers({ ...base, unlistedSources: 'review' })).toMatchObject({
      autoAdmitTrusted: false,
      maxAutoAdmits: 3,
    });
  });

  it('keeps stored values', () => {
    expect(upgradeLegacyResearchLevers({ ...base, autoAdmitTrusted: true, maxAutoAdmits: 9 })).toMatchObject({
      autoAdmitTrusted: true,
      maxAutoAdmits: 9,
    });
  });
});
