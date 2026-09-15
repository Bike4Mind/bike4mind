import { describe, it, expect } from 'vitest';
import { globMatches } from './globMatches';

describe('globMatches', () => {
  it('matches exact names and simple wildcards', () => {
    expect(globMatches('web_search', 'web_search')).toBe(true);
    expect(globMatches('web_search', 'web_*')).toBe(true);
    expect(globMatches('web_search', '*_search')).toBe(true);
    expect(globMatches('mcp__github__create_issue', 'mcp__*__create_*')).toBe(true);
    expect(globMatches('bash_execute', 'file_*')).toBe(false);
  });

  it('handles leading, trailing and bare stars', () => {
    expect(globMatches('anything', '*')).toBe(true);
    expect(globMatches('', '*')).toBe(true);
    expect(globMatches('', '')).toBe(true);
    expect(globMatches('abc', '')).toBe(false);
    expect(globMatches('abc', 'a***c')).toBe(true);
  });

  // The discriminating pair: a regex-based matcher escapes `.` and `[ab]` into a character
  // class, so it would answer these the other way round in both directions.
  it('treats every non-star character as a literal', () => {
    expect(globMatches('a.b', 'a.b')).toBe(true);
    expect(globMatches('axb', 'a.b')).toBe(false);
    expect(globMatches('x[ab]', '*[ab]')).toBe(true);
    expect(globMatches('xa', '*[ab]')).toBe(false);
  });

  it('resolves a chained-star pattern in linear time rather than backtracking', () => {
    // The ReDoS shape: `(.*a){N}Z` against a non-matching subject. Compiled as a RegExp this
    // does not finish; the two-pointer walk must answer well inside the budget.
    const pattern = '*a'.repeat(20) + 'Z';
    const toolName = 'a'.repeat(40);
    const start = Date.now();
    expect(globMatches(toolName, pattern)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
