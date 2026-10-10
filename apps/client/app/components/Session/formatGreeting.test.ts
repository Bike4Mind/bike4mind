import { describe, it, expect } from 'vitest';
import { formatGreeting } from './formatGreeting';

describe('formatGreeting', () => {
  it('uses the first name of the display name', () => {
    expect(formatGreeting('Good morning', 'Ada Lovelace')).toBe('Good morning, Ada');
  });

  it('omits the name when no display name is set', () => {
    expect(formatGreeting('Good morning', undefined)).toBe('Good morning');
    expect(formatGreeting('Good morning', '   ')).toBe('Good morning');
  });
});
