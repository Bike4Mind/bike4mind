import { describe, it, expect } from 'vitest';
import { isUntrackedFabFileKey } from './untrackedFabFileKey';

describe('isUntrackedFabFileKey', () => {
  it.each(['tts-offload/abc.mp3', 'temp/abc', 'exports/abc.csv'])('skips %s', key => {
    expect(isUntrackedFabFileKey(key)).toBe(true);
  });

  it.each(['generated-audio/abc.mp3', 'user-1/file.txt'])('does not skip %s', key => {
    expect(isUntrackedFabFileKey(key)).toBe(false);
  });
});
