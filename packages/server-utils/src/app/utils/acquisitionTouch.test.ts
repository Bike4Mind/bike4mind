import { describe, expect, it } from 'vitest';
import { acquisitionKeyOf, attributedTouch } from './acquisitionTouch';

describe('acquisitionKeyOf', () => {
  it('keeps a plain touch readable', () => {
    expect(acquisitionKeyOf({ source: ' Google ', medium: 'CPC' })).toBe('google|cpc|(none)');
  });

  it('gives touches that differ only in where a pipe falls different keys', () => {
    const keys = [
      acquisitionKeyOf({ source: 'a|b', medium: 'c', campaign: 'd' }),
      acquisitionKeyOf({ source: 'a', medium: 'b|c', campaign: 'd' }),
      acquisitionKeyOf({ source: 'a\\', medium: 'b|c', campaign: 'd' }),
      acquisitionKeyOf({ source: 'a\\|b', medium: 'c', campaign: 'd' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('matches the key attributedTouch gives the same stored touch', () => {
    const touch = attributedTouch({ firstTouch: { source: 'x|y', medium: 'z' } }, 'first');
    expect(touch?.key).toBe(acquisitionKeyOf({ source: 'x|y', medium: 'z' }));
  });
});
