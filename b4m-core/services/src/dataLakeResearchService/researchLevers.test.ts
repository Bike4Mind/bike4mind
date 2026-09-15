import { describe, it, expect } from 'vitest';
import {
  RESEARCH_COST_CEILING_MICRO_USD_DEFAULT,
  RESEARCH_COST_CEILING_MICRO_USD_LIMIT,
  RESEARCH_CONFIG_QUERY_MAX_CHARS,
  RESEARCH_DOMAIN_LIST_MAX,
  RESEARCH_MAX_PROPOSALS_DEFAULT,
  RESEARCH_MAX_PROPOSALS_LIMIT,
  RESEARCH_MAX_RESULTS_DEFAULT,
  RESEARCH_MAX_RESULTS_LIMIT,
  RESEARCH_MIN_RELEVANCE_DEFAULT,
  RESEARCH_RECENCY_DAYS_LIMIT,
} from '@bike4mind/common';
import { normalizeResearchLevers } from './researchLevers';

describe('normalizeResearchLevers', () => {
  it('fills every lever from the shared defaults when only a query is given', () => {
    expect(normalizeResearchLevers({ query: 'coastal erosion' })).toEqual({
      query: 'coastal erosion',
      maxResults: RESEARCH_MAX_RESULTS_DEFAULT,
      maxProposals: RESEARCH_MAX_PROPOSALS_DEFAULT,
      allowedDomains: [],
      blockedDomains: [],
      minRelevance: RESEARCH_MIN_RELEVANCE_DEFAULT,
      costCeilingMicroUsd: RESEARCH_COST_CEILING_MICRO_USD_DEFAULT,
      proposedTags: [],
    });
  });

  it('refuses an empty query, the one lever with no sane substitute', () => {
    expect(() => normalizeResearchLevers({})).toThrow(/question to research/);
    expect(() => normalizeResearchLevers({ query: '   ' })).toThrow(/question to research/);
  });

  it('truncates an overlong query rather than refusing it', () => {
    const long = 'a'.repeat(RESEARCH_CONFIG_QUERY_MAX_CHARS + 50);
    expect(normalizeResearchLevers({ query: long }).query).toHaveLength(RESEARCH_CONFIG_QUERY_MAX_CHARS);
  });

  // The reason normalization lives here rather than at the route: a stored config written before a
  // bound tightened has to keep opening, and has to run clamped.
  it('clamps out-of-range numbers instead of throwing', () => {
    const levers = normalizeResearchLevers({
      query: 'q',
      maxResults: 5_000,
      maxProposals: 0,
      minRelevance: 4,
      costCeilingMicroUsd: RESEARCH_COST_CEILING_MICRO_USD_LIMIT * 10,
      recencyDays: RESEARCH_RECENCY_DAYS_LIMIT + 1,
    });
    expect(levers.maxResults).toBe(RESEARCH_MAX_RESULTS_LIMIT);
    expect(levers.maxProposals).toBe(1);
    expect(levers.minRelevance).toBe(1);
    expect(levers.costCeilingMicroUsd).toBe(RESEARCH_COST_CEILING_MICRO_USD_LIMIT);
    expect(levers.recencyDays).toBe(RESEARCH_RECENCY_DAYS_LIMIT);
  });

  // The other end of the same clamp. maxProposals is the one lever that bounds how much a single run
  // can put in front of a human, so its UPPER bound matters more than its lower one.
  it('clamps maxProposals down to its limit', () => {
    expect(normalizeResearchLevers({ query: 'q', maxProposals: 10_000 }).maxProposals).toBe(
      RESEARCH_MAX_PROPOSALS_LIMIT
    );
  });

  it('floors the cost ceiling at 1, so a saved config can never be unable to judge anything', () => {
    expect(normalizeResearchLevers({ query: 'q', costCeilingMicroUsd: 0 }).costCeilingMicroUsd).toBe(1);
    expect(normalizeResearchLevers({ query: 'q', costCeilingMicroUsd: -5 }).costCeilingMicroUsd).toBe(1);
  });

  it('falls back to the default relevance floor on a non-number, never to 0', () => {
    // 0 would mean "propose everything", which is the opposite of a conservative fallback.
    expect(normalizeResearchLevers({ query: 'q', minRelevance: Number.NaN }).minRelevance).toBe(
      RESEARCH_MIN_RELEVANCE_DEFAULT
    );
  });

  it('drops recencyDays entirely when it is 0 or unset, so there is one spelling of "no limit"', () => {
    expect(normalizeResearchLevers({ query: 'q' })).not.toHaveProperty('recencyDays');
    expect(normalizeResearchLevers({ query: 'q', recencyDays: 0 })).not.toHaveProperty('recencyDays');
    expect(normalizeResearchLevers({ query: 'q', recencyDays: null })).not.toHaveProperty('recencyDays');
    expect(normalizeResearchLevers({ query: 'q', recencyDays: 30 }).recencyDays).toBe(30);
  });

  it('drops a blank or null model, leaving resolution to the deployment catalog', () => {
    expect(normalizeResearchLevers({ query: 'q', model: null })).not.toHaveProperty('model');
    expect(normalizeResearchLevers({ query: 'q', model: '  ' })).not.toHaveProperty('model');
    expect(normalizeResearchLevers({ query: 'q', model: ' gpt-4.1-mini ' }).model).toBe('gpt-4.1-mini');
  });

  describe('domain lists', () => {
    it('lowercases, trims, dedupes and drops empties', () => {
      expect(
        normalizeResearchLevers({ query: 'q', allowedDomains: [' Example.COM ', 'example.com', '', '   '] })
          .allowedDomains
      ).toEqual(['example.com']);
    });

    // A wildcard or leading dot is how people habitually write a suffix rule; left as written it
    // would match nothing, which fails OPEN on an allow list and CLOSED on a deny list.
    it('strips a leading wildcard or dot so a habitual suffix rule still matches', () => {
      expect(
        normalizeResearchLevers({ query: 'q', blockedDomains: ['*.spam.net', '.junk.org'] }).blockedDomains
      ).toEqual(['spam.net', 'junk.org']);
    });

    it('strips a pasted path, keeping the host a rule can be matched against', () => {
      expect(normalizeResearchLevers({ query: 'q', allowedDomains: ['example.com/docs/a'] }).allowedDomains).toEqual([
        'example.com',
      ]);
    });

    // Every one of these failed OPEN on a deny list before the entry was parsed rather than
    // string-sliced: the value never reduced to a hostname, so it matched nothing and nothing told
    // the manager their rule had not taken.
    it.each([
      ['a pasted URL', 'https://spam.net', 'spam.net'],
      ['a pasted URL with a path', 'https://spam.net/articles/1', 'spam.net'],
      ['credentials and a port', 'http://user:pw@Spam.NET:8443/x', 'spam.net'],
      ['a trailing root dot', 'spam.net.', 'spam.net'],
      ['a bare wildcard', '*spam.net', 'spam.net'],
      // The hostname a URL actually carries is the punycode form, so a unicode entry has to become
      // one here or it can never match.
      ['a unicode host', '\u043f\u0440\u0438\u0432\u0435\u0442.com', 'xn--b1agh1afp.com'],
    ])('reduces %s to the hostname a rule is matched against', (_label, entry, expected) => {
      expect(normalizeResearchLevers({ query: 'q', blockedDomains: [entry] }).blockedDomains).toEqual([expected]);
    });

    it('drops an entry that cannot be a hostname at all rather than keeping a rule that matches nothing', () => {
      expect(normalizeResearchLevers({ query: 'q', blockedDomains: ['not a host', '***'] }).blockedDomains).toEqual([]);
    });

    it('caps the list length', () => {
      const many = Array.from({ length: RESEARCH_DOMAIN_LIST_MAX + 10 }, (_v, i) => `d${i}.com`);
      expect(normalizeResearchLevers({ query: 'q', allowedDomains: many }).allowedDomains).toHaveLength(
        RESEARCH_DOMAIN_LIST_MAX
      );
    });

    it('ignores non-string entries rather than stringifying them', () => {
      const input = { query: 'q', allowedDomains: [null, 7, 'ok.com'] as unknown as string[] };
      expect(normalizeResearchLevers(input).allowedDomains).toEqual(['ok.com']);
    });
  });

  it('trims and dedupes proposed tags without touching the reserved namespace', () => {
    // Reserved-namespace stripping belongs to the queue door; duplicating it here is how the two
    // copies drift.
    expect(
      normalizeResearchLevers({ query: 'q', proposedTags: [' research ', 'research', 'datalake:x'] }).proposedTags
    ).toEqual(['research', 'datalake:x']);
  });
});
