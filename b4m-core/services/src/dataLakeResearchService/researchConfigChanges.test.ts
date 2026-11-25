import { describe, it, expect } from 'vitest';
import type { ResearchRunLevers } from '@bike4mind/common';
import {
  LEVER_EQUALITY,
  diffResearchConfig,
  snapshotLeverChanges,
  type ResearchConfigState,
} from './researchConfigChanges';

const FEED = 'https://example.com/feed.xml?token=secret-abc';

const levers = (over: Partial<ResearchRunLevers> = {}): ResearchRunLevers => ({
  source: 'feed',
  feedUrl: FEED,
  query: 'coastal erosion',
  model: 'gpt-4.1-mini',
  maxResults: 10,
  maxProposals: 5,
  recencyDays: 30,
  trustedDomains: ['a.org'],
  reviewDomains: ['b.org'],
  unlistedSources: 'drop',
  autoAdmitTrusted: false,
  maxAutoAdmits: 3,
  allowedDomains: ['a.org', 'b.org'],
  blockedDomains: [],
  minRelevance: 0.6,
  costCeilingMicroUsd: 50_000,
  proposedTags: ['research'],
  itemRules: [],
  ...over,
});

const state = (over: Partial<ResearchConfigState> = {}, leverOver: Partial<ResearchRunLevers> = {}) =>
  ({
    name: 'Weekly sweep',
    levers: levers(leverOver),
    cadence: 'off',
    reviewBacklogLimit: 20,
    schedulePaused: false,
    ...over,
  }) as ResearchConfigState;

// allowedDomains is derived from the three tier lists, so it can never be the reason a config moved.
const CHANGED: Record<Exclude<keyof ResearchRunLevers, 'allowedDomains'>, Partial<ResearchRunLevers>> = {
  source: { source: 'search', feedUrl: null },
  feedUrl: { feedUrl: 'https://example.com/other.xml' },
  query: { query: 'sea level' },
  model: { model: 'gpt-4.1' },
  maxResults: { maxResults: 12 },
  maxProposals: { maxProposals: 6 },
  recencyDays: { recencyDays: 60 },
  trustedDomains: { trustedDomains: ['a.org', 'c.org'] },
  reviewDomains: { reviewDomains: ['b.org', 'd.org', 'e.org'] },
  unlistedSources: { unlistedSources: 'review' },
  autoAdmitTrusted: { autoAdmitTrusted: true },
  maxAutoAdmits: { maxAutoAdmits: 4 },
  blockedDomains: { blockedDomains: ['x.org'] },
  minRelevance: { minRelevance: 0.5 },
  costCeilingMicroUsd: { costCeilingMicroUsd: 60_000 },
  proposedTags: { proposedTags: ['research', 'new'] },
  itemRules: { itemRules: [{ condition: 'is a press release', action: 'block' }] },
};

describe('diffResearchConfig', () => {
  it('covers every lever in LEVER_EQUALITY', () => {
    const covered = [...Object.keys(CHANGED), 'allowedDomains'].sort();
    expect(Object.keys(LEVER_EQUALITY).sort()).toEqual(covered);
  });

  it.each(Object.entries(CHANGED))('%s yields a prose line and a structured change', (key, patch) => {
    const diff = diffResearchConfig(state(), state({}, patch));
    expect(diff.leverChanges.map(c => c.lever)).toContain(key);
    expect(diff.leverLines.length).toBeGreaterThanOrEqual(1);
    expect(diff.scheduleLines).toEqual([]);
  });

  it('yields nothing for allowedDomains alone', () => {
    const diff = diffResearchConfig(state(), state({}, { allowedDomains: ['z.org'] }));
    expect(diff).toEqual({ scheduleLines: [], leverLines: [], leverChanges: [] });
  });

  it('writes no line and no change for an unchanged lever', () => {
    const diff = diffResearchConfig(state(), state({}, { minRelevance: 0.5 }));
    expect(diff.leverChanges.map(c => c.lever)).toEqual(['minRelevance']);
    expect(diff.leverLines).toHaveLength(1);
    expect(diff.leverLines[0].after).toBe('min_relevance 0.6 -> 0.5: Weekly sweep');
  });

  it('summarizes lists as counts', () => {
    const diff = diffResearchConfig(
      state({}, { reviewDomains: ['b.org', 'c.org'] }),
      state({}, { reviewDomains: ['x.org', 'y.org', 'z.org'] })
    );
    expect(diff.leverLines[0].after).toBe('review_domains 3 sites added, 2 removed: Weekly sweep');
  });

  it('records the schedulePaused flip when cadence goes off, without a pause line', () => {
    const diff = diffResearchConfig(
      state({ cadence: 'daily', schedulePaused: true }),
      state({ cadence: 'off', schedulePaused: false })
    );
    expect(diff.leverChanges.map(c => c.lever)).toEqual(['schedulePaused', 'cadence']);
    expect(diff.scheduleLines).toHaveLength(1);
    expect(String(diff.scheduleLines[0].after)).not.toMatch(/resum/i);
  });

  it('records a pause as both a line and a structured change', () => {
    const diff = diffResearchConfig(state({ cadence: 'daily' }), state({ cadence: 'daily', schedulePaused: true }));
    expect(diff.leverChanges).toEqual([{ lever: 'schedulePaused', before: false, after: true }]);
    expect(diff.scheduleLines).toHaveLength(1);
  });

  it('redacts the feed address to origin and path in every output', () => {
    const next = 'https://example.com/other.xml?key=another-secret';
    const diff = diffResearchConfig(state(), state({}, { feedUrl: next }));
    const out = JSON.stringify(diff);
    expect(out).not.toContain('secret-abc');
    expect(out).not.toContain('another-secret');
    expect(out).not.toContain('?');
    expect(diff.leverChanges[0]).toEqual({
      lever: 'feedUrl',
      before: 'https://example.com/feed.xml',
      after: 'https://example.com/other.xml',
    });
  });
});

describe('snapshotLeverChanges', () => {
  it('records every setting with after null and no query string', () => {
    const out = snapshotLeverChanges(state({ cadence: 'daily' }));
    expect(out.every(c => c.after === null)).toBe(true);
    expect(out.map(c => c.lever)).toEqual(
      expect.arrayContaining(['name', 'cadence', 'reviewBacklogLimit', 'schedulePaused', 'feedUrl', 'query'])
    );
    expect(JSON.stringify(out)).not.toContain('secret-abc');
  });
});
