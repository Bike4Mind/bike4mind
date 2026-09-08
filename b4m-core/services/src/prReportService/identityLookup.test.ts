import { describe, it, expect } from 'vitest';

import { buildIdentityLookup, parseIdentityMap } from './identityLookup';

describe('parseIdentityMap - tolerant line formats', () => {
  it('accepts space, equals and colon separators', () => {
    const result = parseIdentityMap(['wescarda U0WESCARD', 'onoya=U0ONOYA11', 'dea0030: U0DEA0030'].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      { key: 'wescarda', memberId: 'U0WESCARD' },
      { key: 'onoya', memberId: 'U0ONOYA11' },
      { key: 'dea0030', memberId: 'U0DEA0030' },
    ]);
  });

  it('lowercases keys so login matching is case-insensitive', () => {
    const result = parseIdentityMap('WesCarda U0WESCARD');
    expect(result.entries[0].key).toBe('wescarda');
  });

  it('resolves synthetic role keys alongside logins in one keyspace', () => {
    const result = parseIdentityMap(['reviewer_ S0REVIEWERS', 'qa_ S0QAPOOL11', 'wescarda U0WESCARD'].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.entries.map(e => e.key)).toEqual(['reviewer_', 'qa_', 'wescarda']);
  });

  it('ignores blank lines and comments', () => {
    const result = parseIdentityMap(['# reviewers', '', '   ', 'wescarda U0WESCARD', '# trailing note'].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it('handles empty, null and undefined input', () => {
    for (const input of ['', null, undefined]) {
      expect(parseIdentityMap(input)).toEqual({ entries: [], errors: [] });
    }
  });
});

describe('parseIdentityMap - errors carry line numbers', () => {
  it('reports a malformed line', () => {
    const result = parseIdentityMap(['wescarda U0WESCARD', 'garbage-with-no-value'].join('\n'));

    expect(result.entries).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
  });

  it('rejects a display name, which would produce no notification', () => {
    const result = parseIdentityMap('wescarda @wes');

    expect(result.entries).toEqual([]);
    expect(result.errors[0].line).toBe(1);
    expect(result.errors[0].reason).toContain('not a Slack member id');
  });

  it('rejects a duplicate key and names the line it first appeared on', () => {
    const result = parseIdentityMap(['wescarda U0WESCARD', 'wescarda U0OTHER11'].join('\n'));

    expect(result.entries).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
    expect(result.errors[0].reason).toContain('line 1');
  });

  it('accepts user, bot and usergroup id prefixes', () => {
    const result = parseIdentityMap(['a U0AAAAAAA', 'b W0BBBBBBB', 'c S0CCCCCCC'].join('\n'));
    expect(result.errors).toEqual([]);
  });
});

describe('buildIdentityLookup', () => {
  it('flattens parsed entries into the renderer lookup', () => {
    const lookup = buildIdentityLookup(['wescarda U0WESCARD', 'reviewer_ S0REVIEWERS'].join('\n'));

    expect(lookup).toEqual({ wescarda: 'U0WESCARD', reviewer_: 'S0REVIEWERS' });
  });

  it('skips malformed lines so a partly-broken map still mentions everyone who parsed', () => {
    const lookup = buildIdentityLookup(['wescarda U0WESCARD', 'broken @nope'].join('\n'));

    expect(lookup).toEqual({ wescarda: 'U0WESCARD' });
  });
});
