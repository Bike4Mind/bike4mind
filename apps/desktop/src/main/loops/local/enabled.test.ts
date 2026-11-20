import { describe, expect, it } from 'vitest';
import { readLoopsEnabled } from './enabled';

describe('readLoopsEnabled', () => {
  it('reads the stored flag', () => {
    expect(readLoopsEnabled([{ settingName: 'EnableLoops', settingValue: true }])).toBe(true);
    expect(readLoopsEnabled([{ settingName: 'EnableLoops', settingValue: false }])).toBe(false);
  });

  it('falls back to the default (off) for a missing or malformed row', () => {
    expect(readLoopsEnabled([{ settingName: 'Other', settingValue: true }])).toBe(false);
    expect(readLoopsEnabled([{ settingName: 'EnableLoops', settingValue: 'yes' }])).toBe(false);
  });

  it('is undefined for anything but the rows', () => {
    expect(readLoopsEnabled(null)).toBeUndefined();
    expect(readLoopsEnabled({ error: 'x' })).toBeUndefined();
  });
});
