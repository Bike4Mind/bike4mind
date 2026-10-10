import { describe, expect, it } from 'vitest';
import { validateEditKey } from './TavernWorldModel';

describe('validateEditKey', () => {
  it.each(['ground:0,0', 'walls:159,159', 'ground:159,0', 'decoration:10,100'])('accepts %s', key => {
    expect(validateEditKey(key)).toBe(true);
  });

  it.each([
    'ground:160,0',
    'ground:0,160',
    'ground:-1,0',
    'ground:0,-1',
    'ground:5abc,0',
    'ground:0,5abc',
    'ground:1.5,0',
    'ground:007,0',
    'ground:0,007',
    'ground:1e2,0',
    'ground:+5,0',
    'ground:,0',
    'ground: 5,0',
    'bogus:1,1',
    'ground:1',
    'ground:1,2,3',
  ])('rejects %s', key => {
    expect(validateEditKey(key)).toBe(false);
  });
});
