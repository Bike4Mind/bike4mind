import { describe, it, expect } from 'vitest';
import { normalizeRecipients } from './notebookRecipients';

describe('normalizeRecipients', () => {
  it('trims padding from each address', () => {
    expect(normalizeRecipients([' a@example.com ', 'b@example.com'])).toEqual(['a@example.com', 'b@example.com']);
  });

  it('drops blank and malformed entries', () => {
    expect(normalizeRecipients(['   ', 'not-an-email', 'c@example.com'])).toEqual(['c@example.com']);
  });

  it('returns an empty list when nothing is valid', () => {
    expect(normalizeRecipients(['  ', ''])).toEqual([]);
  });
});
