import { describe, it, expect } from 'vitest';
import { assertParseableDate, dateParam, isParseableDate } from './dateParam';

describe('assertParseableDate', () => {
  it('throws a 400 for an unparseable value', () => {
    expect(() => assertParseableDate('startDate', 'not-a-date')).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  // Every call site skips a falsy date, so rejecting these would fail requests that succeed
  // today. Only a present, unparseable value is a client error.
  it.each([undefined, ''])('lets %p through untouched', value => {
    expect(() => assertParseableDate('startDate', value)).not.toThrow();
  });

  it('lets a parseable value through', () => {
    expect(() => assertParseableDate('startDate', '2026-08-01T00:00:00.000Z')).not.toThrow();
  });
});

describe('dateParam', () => {
  it('rejects an unparseable value', () => {
    expect(dateParam.safeParse('not-a-date').success).toBe(false);
  });

  it.each(['', '2026-08-01T00:00:00.000Z'])('accepts %p', value => {
    expect(dateParam.safeParse(value).success).toBe(true);
  });
});

describe('isParseableDate', () => {
  it('agrees with the Date constructor', () => {
    for (const value of ['2026-08-01', 'not-a-date', '', '2026-13-45']) {
      expect(isParseableDate(value)).toBe(!Number.isNaN(new Date(value).getTime()));
    }
  });
});
