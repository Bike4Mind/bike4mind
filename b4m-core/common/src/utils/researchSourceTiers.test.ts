import { describe, it, expect } from 'vitest';
import {
  cleanResearchItemRuleCondition,
  deriveLegacyAllowedDomains,
  canonicalItemRules,
  isSameDomainSet,
  normalizeDomainEntry,
  normalizeItemRules,
  researchItemRuleKey,
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

describe('upgradeLegacyResearchLevers - feed source', () => {
  it('reads an absent source as search and an absent feedUrl as null', () => {
    const upgraded = upgradeLegacyResearchLevers(base);
    expect(upgraded.source).toBe('search');
    expect(upgraded.feedUrl).toBeNull();
  });

  it('keeps a feed source and its url', () => {
    const upgraded = upgradeLegacyResearchLevers({ ...base, source: 'feed', feedUrl: 'https://example.com/f.xml' });
    expect(upgraded.source).toBe('feed');
    expect(upgraded.feedUrl).toBe('https://example.com/f.xml');
  });

  it('reads an unknown source as search', () => {
    const upgraded = upgradeLegacyResearchLevers({ ...base, source: 'rss' as never });
    expect(upgraded.source).toBe('search');
  });
});

describe('item rules', () => {
  it('reads an absent itemRules as empty and keeps a stored list', () => {
    expect(upgradeLegacyResearchLevers(base).itemRules).toEqual([]);
    const itemRules = [{ condition: 'c', action: 'block' as const }];
    expect(upgradeLegacyResearchLevers({ ...base, itemRules }).itemRules).toEqual(itemRules);
  });

  it('keys a rule on trimmed, case-folded condition plus action', () => {
    expect(researchItemRuleKey({ condition: ' Abc ', action: 'block' })).toBe(
      researchItemRuleKey({ condition: 'abc', action: 'block' })
    );
    expect(researchItemRuleKey({ condition: 'abc', action: 'review' })).not.toBe(
      researchItemRuleKey({ condition: 'abc', action: 'block' })
    );
  });

  it('trims, drops empty conditions and bad actions, and dedupes on the canonical key', () => {
    expect(
      canonicalItemRules([
        { condition: ' A ', action: 'block' },
        { condition: 'a', action: 'block' },
        { condition: 'a', action: 'review' },
        { condition: '   ', action: 'block' },
        { condition: 'b', action: 'allow' },
        { condition: 'c' },
        { condition: 5, action: 'block' },
        null,
        'x',
      ])
    ).toEqual([
      { condition: 'A', action: 'block' },
      { condition: 'a', action: 'review' },
    ]);
  });

  it('clamps count and condition length as a stored-data backstop', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ condition: `rule ${i}`, action: 'block' }));
    expect(normalizeItemRules(many)).toHaveLength(10);
    expect(normalizeItemRules([{ condition: 'x'.repeat(400), action: 'review' }])[0].condition).toHaveLength(300);
    expect(normalizeItemRules(undefined)).toEqual([]);
  });
});

describe('cleanResearchItemRuleCondition', () => {
  it('reduces a zero-width-only condition to empty', () => {
    expect(cleanResearchItemRuleCondition('\u200B\u200C\u200D\u2060\uFEFF')).toBe('');
  });

  it('removes C0, DEL and C1 control characters', () => {
    expect(cleanResearchItemRuleCondition('a\u0000b\u001Fc\u007Fd\u0080e\u009Ff')).toBe('abcdef');
  });

  it('turns tab, newline and carriage return into a space', () => {
    expect(cleanResearchItemRuleCondition('a\tb\nc\r\nd')).toBe('a b c d');
  });

  it.each([
    ['soft hyphen', '\u00AD'],
    ['invisible operators', '\u2061\u2062'],
    ['variation selector', '\uFE0F'],
    ['tag character', '\u{E0041}'],
    ['hangul filler', '\u3164'],
    ['braille blank', '\u2800'],
  ])('reduces a lone %s to empty', (_name, char) => {
    expect(cleanResearchItemRuleCondition(char)).toBe('');
  });

  it.each([
    ['vertical tab', '\v'],
    ['form feed', '\f'],
    ['NEL', '\u0085'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
  ])('turns %s between words into one space', (_name, char) => {
    expect(cleanResearchItemRuleCondition('press' + char + 'release')).toBe('press release');
  });

  it('collapses whitespace left around a stripped character', () => {
    expect(cleanResearchItemRuleCondition('a \u200B b')).toBe('a b');
  });

  it('keys conditions that differ only in line breaks or spacing identically', () => {
    const keys = ['a b', 'a\nb', 'a\r\nb', 'a  b'].map(condition =>
      researchItemRuleKey({ condition, action: 'block' })
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('leaves accents, CJK and emoji unchanged', () => {
    expect(cleanResearchItemRuleCondition('caf\u00E9 \u65E5\u672C\u8A9E \u{1F600}')).toBe(
      'caf\u00E9 \u65E5\u672C\u8A9E \u{1F600}'
    );
  });

  it('removes bidi controls', () => {
    expect(cleanResearchItemRuleCondition('a\u200E\u200F\u202A\u202E\u2066\u2069\u061Cb')).toBe('ab');
  });

  it('leaves ordinary text, accented letters, CJK and emoji unchanged', () => {
    for (const text of ['Published by Acme, Inc.', 'caf\u00E9 na\u00EFve', '\u65E5\u672C\u8A9E', '\u{1F600} ok']) {
      expect(cleanResearchItemRuleCondition(text)).toBe(text);
    }
  });

  it('strips interlinear annotation, Egyptian format controls and the Khitan filler', () => {
    expect(cleanResearchItemRuleCondition('\uFFF9\uFFFA\uFFFB')).toBe('');
    expect(cleanResearchItemRuleCondition('\u{13430}\u{13431}')).toBe('');
    expect(cleanResearchItemRuleCondition('\u{16FE4}')).toBe('');
  });

  it('keys a capital and a lowercase letter with a combining mark identically', () => {
    expect(researchItemRuleKey({ condition: 'T\u0308 x', action: 'block' })).toBe(
      researchItemRuleKey({ condition: 't\u0308 x', action: 'block' })
    );
  });

  it('keeps visible format marks such as Arabic number signs', () => {
    for (const condition of ['\u0600\u0661\u0662 rule', '\u06DD rule']) {
      expect(cleanResearchItemRuleCondition(condition)).toBe(condition);
    }
  });

  it('keys composed and decomposed accents identically and stores the NFC form', () => {
    const composed = 'caf\u00E9 article';
    const decomposed = 'cafe\u0301 article';
    expect(researchItemRuleKey({ condition: composed, action: 'block' })).toBe(
      researchItemRuleKey({ condition: decomposed, action: 'block' })
    );
    expect(cleanResearchItemRuleCondition(decomposed)).toBe(composed);
  });

  it('strips the ZWJ inside an emoji sequence (accepted)', () => {
    expect(cleanResearchItemRuleCondition('\u{1F468}\u200D\u{1F469}')).toBe('\u{1F468}\u{1F469}');
  });

  it('keys conditions that differ only by invisible characters identically', () => {
    expect(researchItemRuleKey({ condition: 'ab\u200Bc', action: 'block' })).toBe(
      researchItemRuleKey({ condition: 'ABC', action: 'block' })
    );
  });

  it('drops a zero-width-only rule and dedupes conditions differing by a zero-width character', () => {
    expect(
      canonicalItemRules([
        { condition: '\u200B\u200B', action: 'block' },
        { condition: 'ab\u200Bc', action: 'block' },
        { condition: 'abc', action: 'block' },
      ])
    ).toEqual([{ condition: 'abc', action: 'block' }]);
  });
});
