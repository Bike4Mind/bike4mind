import { describe, it, expect } from 'vitest';
import { dedupeTestRecipients } from './emailTestRecipients';

describe('dedupeTestRecipients', () => {
  it('dedupes case-insensitively', () => {
    expect(dedupeTestRecipients(['qa@x.com', 'QA@x.com'])).toEqual(['qa@x.com']);
  });

  it('trims, drops empties, preserves order', () => {
    expect(dedupeTestRecipients([' a@x.com ', 'a@x.com', '', 'b@x.com'])).toEqual(['a@x.com', 'b@x.com']);
  });

  it('returns empty for empty input', () => {
    expect(dedupeTestRecipients([])).toEqual([]);
  });
});
