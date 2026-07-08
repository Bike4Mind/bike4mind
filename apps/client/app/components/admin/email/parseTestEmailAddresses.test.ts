import { describe, it, expect } from 'vitest';
import { parseTestEmailAddresses } from './parseTestEmailAddresses';

describe('parseTestEmailAddresses', () => {
  it('dedupes case-insensitively', () => {
    expect(parseTestEmailAddresses('qa@x.com, QA@x.com')).toEqual(['qa@x.com']);
  });

  it('preserves first-seen order while deduping', () => {
    expect(parseTestEmailAddresses('a@x.com\nb@x.com, a@x.com')).toEqual(['a@x.com', 'b@x.com']);
  });

  it('trims and lowercases', () => {
    expect(parseTestEmailAddresses('  A@X.com ')).toEqual(['a@x.com']);
  });

  it('filters entries without @', () => {
    expect(parseTestEmailAddresses('notanemail, c@x.com')).toEqual(['c@x.com']);
  });

  it('returns empty for blank/separator-only input', () => {
    expect(parseTestEmailAddresses('')).toEqual([]);
    expect(parseTestEmailAddresses(',\n , ')).toEqual([]);
  });
});
