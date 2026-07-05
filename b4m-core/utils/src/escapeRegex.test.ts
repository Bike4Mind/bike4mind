import { describe, it, expect } from 'vitest';
import { escapeRegex } from './escapeRegex';

/**
 * Regression coverage for the regex-injection / ReDoS hardening.
 * Any user-controlled operand passed to a MongoDB `$regex` must be escaped so
 * regex metacharacters are treated as literals, preventing catastrophic
 * backtracking (ReDoS) and query manipulation via anchors/wildcards.
 */
describe('escapeRegex', () => {
  it('escapes every regex metacharacter', () => {
    expect(escapeRegex('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  });

  it('leaves ordinary alphanumeric input untouched but escapes the dot in an email', () => {
    expect(escapeRegex('normalUsername123')).toBe('normalUsername123');
    // `.` is a metacharacter, so it is escaped; the rest is untouched.
    expect(escapeRegex('alice@example.com')).toBe('alice@example\\.com');
  });

  it('neutralizes a catastrophic-backtracking ReDoS payload', () => {
    const payload = '(a+)+$';
    const escaped = escapeRegex(payload);

    // The escaped string must not contain an unescaped quantifier group.
    expect(escaped).toBe('\\(a\\+\\)\\+\\$');

    // And it must match ONLY the literal payload, not act as a pattern:
    // a linear-time match that cannot backtrack catastrophically.
    expect(new RegExp(escaped).test(payload)).toBe(true);
    expect(new RegExp(escaped).test('aaaaaaaaaaaaaaaaaaaa')).toBe(false);
  });

  it('neutralizes anchors and wildcards used for query manipulation', () => {
    const escaped = escapeRegex('.*');
    // `.*` would match everything; escaped it matches only the literal ".*".
    expect(new RegExp(escaped).test('anything')).toBe(false);
    expect(new RegExp(escaped).test('.*')).toBe(true);
  });

  it('round-trips: an escaped value used in RegExp matches only its literal', () => {
    const literal = 'a+b.c*d';
    const re = new RegExp(`^${escapeRegex(literal)}$`);
    expect(re.test(literal)).toBe(true);
    expect(re.test('aaab_c___d')).toBe(false);
  });
});
