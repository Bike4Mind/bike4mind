import { describe, expect, it } from 'vitest';
import type { ResearchFeedFingerprintLevers } from './researchFeedFingerprint';
import { researchFeedFingerprint } from './researchFeedFingerprint';

const base: ResearchFeedFingerprintLevers = {
  feedUrl: 'https://example.com/feed.xml',
  query: 'topic',
  model: 'm1',
  minRelevance: 0.5,
  recencyDays: 30,
  trustedDomains: ['a.com', 'b.com'],
  reviewDomains: [],
  unlistedSources: 'review',
  allowedDomains: [],
  blockedDomains: ['x.com'],
};

describe('researchFeedFingerprint', () => {
  it('is stable and order-insensitive for site lists', () => {
    expect(researchFeedFingerprint(base)).toBe(researchFeedFingerprint({ ...base }));
    expect(researchFeedFingerprint({ ...base, trustedDomains: ['b.com', 'a.com'] })).toBe(
      researchFeedFingerprint(base)
    );
  });

  it.each<[string, Partial<ResearchFeedFingerprintLevers>]>([
    ['feedUrl', { feedUrl: 'https://example.com/other.xml' }],
    ['query', { query: 'other' }],
    ['model', { model: 'm2' }],
    ['minRelevance', { minRelevance: 0.6 }],
    ['recencyDays', { recencyDays: 7 }],
    ['trustedDomains', { trustedDomains: ['a.com'] }],
    ['reviewDomains', { reviewDomains: ['c.com'] }],
    ['unlistedSources', { unlistedSources: 'drop' }],
    ['allowedDomains', { allowedDomains: ['a.com'] }],
    ['blockedDomains', { blockedDomains: [] }],
  ])('changes when %s changes', (_name, patch) => {
    expect(researchFeedFingerprint({ ...base, ...patch })).not.toBe(researchFeedFingerprint(base));
  });

  it('ignores levers that do not decide which items are judged', () => {
    expect(researchFeedFingerprint({ ...base, ...({ maxResults: 3 } as object) })).toBe(researchFeedFingerprint(base));
  });
});
