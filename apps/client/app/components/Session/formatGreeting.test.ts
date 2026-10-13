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

  it('omits the name when it is just the username', () => {
    expect(formatGreeting('Winding down', 'persona-abc-123', 'persona-abc-123')).toBe('Winding down');
    expect(formatGreeting('Winding down', 'Persona-ABC-123', 'persona-abc-123')).toBe('Winding down');
  });

  it('keeps a real name that differs from the username', () => {
    expect(formatGreeting('Good morning', 'Ada Lovelace', 'ada99')).toBe('Good morning, Ada');
  });
});
