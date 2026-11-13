import { describe, it, expect } from 'vitest';
import type { ResearchFeedCursor } from '@bike4mind/common';
import {
  researchFeedFingerprint,
  RESEARCH_FEED_DATE_GRACE_DAYS,
  RESEARCH_FEED_FUTURE_SKEW_MS,
  RESEARCH_FEED_SEEN_KEYS_MAX,
} from '@bike4mind/common';
import { canonicalSourceKey } from '../dataLakeService/canonicalSourceKey';
import type { ResearchCandidate } from './executeResearchRun';
import type { FeedSelectionLevers } from './selectFeedCandidates';
import { selectFeedCandidates } from './selectFeedCandidates';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const levers = (overrides: Partial<FeedSelectionLevers> = {}): FeedSelectionLevers => ({
  feedUrl: 'https://example.org/feed.xml',
  query: 'topic',
  minRelevance: 0.5,
  trustedDomains: [],
  reviewDomains: [],
  unlistedSources: 'review',
  allowedDomains: [],
  maxResults: 10,
  ...overrides,
});

const item = (id: string, publishedAt?: Date): ResearchCandidate => ({
  title: `Item ${id}`,
  url: `https://example.org/${id}`,
  snippet: '',
  ...(publishedAt ? { publishedAt } : {}),
});

const key = (id: string) => canonicalSourceKey(`https://example.org/${id}`)!;
const ids = (candidates: ResearchCandidate[]) => candidates.map(c => c.url.split('/').pop());

/** A cursor as the executor would leave it after every selected item settled. */
const settleAll = (
  l: FeedSelectionLevers,
  previous: ResearchFeedCursor | null,
  selection: ReturnType<typeof selectFeedCandidates>
): ResearchFeedCursor => ({
  fingerprint: researchFeedFingerprint(l),
  newestPublishedAt: previous?.newestPublishedAt ?? null,
  seenKeys: [
    ...(previous?.fingerprint === researchFeedFingerprint(l) ? previous.seenKeys : []),
    ...selection.skipped,
    ...selection.candidates.map(c => canonicalSourceKey(c.url)!),
  ],
  retries: [],
});

describe('selectFeedCandidates - consecutive runs', () => {
  it('offers only items whose keys it has not seen', () => {
    const l = levers();
    const run1 = selectFeedCandidates([item('a', daysAgo(3)), item('b', daysAgo(2))], null, l, NOW);
    expect(ids(run1.candidates)).toEqual(['a', 'b']);
    const cursor = settleAll(l, null, run1);

    const run2 = selectFeedCandidates(
      [item('a', daysAgo(3)), item('b', daysAgo(2)), item('c', daysAgo(1))],
      cursor,
      l,
      NOW
    );
    expect(ids(run2.candidates)).toEqual(['c']);
    expect(selectFeedCandidates([item('a', daysAgo(3))], cursor, l, NOW).candidates).toEqual([]);
  });

  it('first run takes the newest maxResults, returns the rest as skipped, and the next run does not offer them', () => {
    const l = levers({ maxResults: 2 });
    const feed = [item('d1', daysAgo(1)), item('d2', daysAgo(2)), item('d3', daysAgo(3)), item('d4', daysAgo(4))];
    const run1 = selectFeedCandidates(feed, null, l, NOW);
    expect(ids(run1.candidates)).toEqual(['d2', 'd1']);
    expect(run1.skipped).toEqual([key('d4'), key('d3')]);
    expect(run1.backlog).toBe(0);

    const cursor = settleAll(l, null, run1);
    const run2 = selectFeedCandidates([item('d0', NOW), ...feed], cursor, l, NOW);
    expect(ids(run2.candidates)).toEqual(['d0']);
    expect(run2.skipped).toEqual([]);
  });

  it('first run on undated and mixed feeds: dated newest first, undated in feed order', () => {
    const l = levers({ maxResults: 3 });
    const undated = selectFeedCandidates([item('u1'), item('u2'), item('u3'), item('u4')], null, l, NOW);
    expect(ids(undated.candidates)).toEqual(['u1', 'u2', 'u3']);
    expect(undated.skipped).toEqual([key('u4')]);

    const mixed = selectFeedCandidates(
      [item('u1'), item('d1', daysAgo(1)), item('u2'), item('d2', daysAgo(2))],
      null,
      l,
      NOW
    );
    expect(ids(mixed.candidates)).toEqual(['d2', 'd1', 'u1']);
    expect(mixed.skipped).toEqual([key('u2')]);
  });

  it('later runs go oldest first and report what is left as backlog', () => {
    const l = levers({ maxResults: 2 });
    const cursor = settleAll(l, null, { candidates: [], skipped: [], backlog: 0 });
    const feed = [item('n3', daysAgo(1)), item('n1', daysAgo(3)), item('n2', daysAgo(2)), item('u1'), item('u2')];

    const run1 = selectFeedCandidates(feed, cursor, l, NOW);
    expect(ids(run1.candidates)).toEqual(['n1', 'n2']);
    expect(run1.backlog).toBe(3);

    const run2 = selectFeedCandidates(feed, settleAll(l, cursor, run1), l, NOW);
    expect(ids(run2.candidates)).toEqual(['n3', 'u1']);
    expect(run2.backlog).toBe(1);

    const run3 = selectFeedCandidates(feed, settleAll(l, settleAll(l, cursor, run1), run2), l, NOW);
    expect(ids(run3.candidates)).toEqual(['u2']);
    expect(run3.backlog).toBe(0);
  });

  it('offers a never-seen item far older than the floor while keys are below the cap', () => {
    const l = levers();
    const cursor: ResearchFeedCursor = {
      fingerprint: researchFeedFingerprint(l),
      newestPublishedAt: daysAgo(1),
      seenKeys: [key('x')],
      retries: [],
    };
    const result = selectFeedCandidates([item('old', daysAgo(400))], cursor, l, NOW);
    expect(ids(result.candidates)).toEqual(['old']);
  });

  it('at the key cap, drops a dated item older than the floor minus the grace window', () => {
    const l = levers();
    const cursor: ResearchFeedCursor = {
      fingerprint: researchFeedFingerprint(l),
      newestPublishedAt: daysAgo(1),
      seenKeys: Array.from({ length: RESEARCH_FEED_SEEN_KEYS_MAX }, (_, i) => `k${i}`),
      retries: [],
    };
    const feed = [
      item('trimmed', daysAgo(1 + RESEARCH_FEED_DATE_GRACE_DAYS + 1)),
      item('inside-grace', daysAgo(1 + RESEARCH_FEED_DATE_GRACE_DAYS - 1)),
      item('undated'),
    ];
    expect(ids(selectFeedCandidates(feed, cursor, l, NOW).candidates)).toEqual(['inside-grace', 'undated']);
  });

  it('clamps a future-dated item to now plus the skew allowance', () => {
    const l = levers();
    const cursor = settleAll(l, null, { candidates: [], skipped: [], backlog: 0 });
    const result = selectFeedCandidates([item('future', new Date('2030-01-01T00:00:00Z'))], cursor, l, NOW);
    expect(result.candidates[0].publishedAt).toEqual(new Date(NOW.getTime() + RESEARCH_FEED_FUTURE_SKEW_MS));
  });

  it.each<[string, Partial<FeedSelectionLevers>]>([
    ['feed url', { feedUrl: 'https://example.org/other.xml' }],
    ['topic', { query: 'another topic' }],
    ['threshold', { minRelevance: 0.9 }],
    ['trusted list', { trustedDomains: ['example.org'] }],
    ['review list', { reviewDomains: ['example.org'] }],
    ['blocked list', { blockedDomains: ['spam.example'] }],
    ['recency', { recencyDays: 60 }],
  ])('ignores a cursor written under a different %s', (_name, change) => {
    const before = levers();
    const feed = [item('a', daysAgo(3)), item('b', daysAgo(2))];
    const run1 = selectFeedCandidates(feed, null, before, NOW);
    const cursor = settleAll(before, null, run1);
    expect(selectFeedCandidates(feed, cursor, before, NOW).candidates).toEqual([]);

    const after = levers(change);
    const rerun = selectFeedCandidates(feed, cursor, after, NOW);
    expect(ids(rerun.candidates)).toEqual(['a', 'b']);
  });

  it('applies recencyDays to dated items only', () => {
    const l = levers({ recencyDays: 7 });
    const result = selectFeedCandidates(
      [item('old', daysAgo(30)), item('new', daysAgo(2)), item('undated')],
      null,
      l,
      NOW
    );
    expect(ids(result.candidates)).toEqual(['new', 'undated']);
    expect(result.skipped).toEqual([]);
  });

  it('collapses duplicate urls inside one feed', () => {
    const result = selectFeedCandidates([item('a', daysAgo(2)), item('a', daysAgo(1))], null, levers(), NOW);
    expect(ids(result.candidates)).toEqual(['a']);
  });
});
