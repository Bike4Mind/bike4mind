import { describe, expect, it } from 'vitest';
import type { ResearchFeedFingerprintLevers } from './researchFeedFingerprint';
import {
  researchFeedFingerprint,
  researchFeedStatus,
  researchFeedUrlKey,
  withResearchFeedStatus,
} from './researchFeedFingerprint';

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

describe('researchFeedUrlKey', () => {
  it('depends on the address alone', () => {
    expect(researchFeedUrlKey(base.feedUrl)).toBe(researchFeedUrlKey(base.feedUrl));
    expect(researchFeedUrlKey(base.feedUrl)).not.toBe(researchFeedUrlKey('https://example.com/other.xml'));
    expect(researchFeedUrlKey(base.feedUrl)).not.toContain('example');
  });
});

describe('researchFeedStatus', () => {
  const cursor = (fingerprint: string) => ({
    fingerprint,
    newestPublishedAt: new Date('2026-11-01T00:00:00Z'),
    seenKeys: ['k'],
    retries: [],
  });

  it('is null with no cursor', () => {
    expect(researchFeedStatus({ feedCursor: null }, base)).toBeNull();
    expect(researchFeedStatus({}, base)).toBeNull();
  });

  it('is current when the cursor was written under the config levers, and not after a lever changes', () => {
    const written = cursor(researchFeedFingerprint(base));
    expect(researchFeedStatus({ feedCursor: written }, base)).toEqual({
      newestPublishedAt: written.newestPublishedAt,
      current: true,
    });
    expect(researchFeedStatus({ feedCursor: written }, { ...base, query: 'other topic' })?.current).toBe(false);
  });

  it('withResearchFeedStatus swaps the cursor for its status and keeps the rest', () => {
    const out = withResearchFeedStatus({ ...base, id: 'c1', feedCursor: cursor(researchFeedFingerprint(base)) }, base);
    expect(out).not.toHaveProperty('feedCursor');
    expect(out).toMatchObject({ id: 'c1', query: 'topic', feedStatus: { current: true } });
  });
});
