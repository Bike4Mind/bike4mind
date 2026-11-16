import { describe, expect, it } from 'vitest';
import { joinAnnouncements } from './announcements';

describe('joinAnnouncements', () => {
  it('speaks up to three updates in full', () => {
    expect(joinAnnouncements(['A finished', 'B needs you', 'C failed'])).toBe('A finished. B needs you. C failed.');
  });

  it('folds the rest into a count past three', () => {
    expect(joinAnnouncements(['A finished', 'B needs you', 'C failed', 'D finished'])).toBe(
      'A finished. B needs you. C failed. 1 more update.'
    );
    expect(joinAnnouncements(['A finished', 'B needs you', 'C failed', 'D finished', 'E failed'])).toBe(
      'A finished. B needs you. C failed. 2 more updates.'
    );
  });
});
