import { describe, expect, it } from 'vitest';
import { LYRIC_LINE_TIMING_SOURCE } from './lyricTiming';

const whole = new RegExp(`^${LYRIC_LINE_TIMING_SOURCE}$`);

describe('LYRIC_LINE_TIMING_SOURCE', () => {
  it.each(['[:]', '[3.4:6.9]', '[7:12.25]', '[0:0]'])('matches %s', marker => {
    expect(whole.test(marker)).toBe(true);
  });

  // Lyria has only been seen emitting `[:]` or a fully filled timing; section tags must survive.
  it.each(['[3.4:]', '[:6.9]', '[.5:1]', '[]', '[Chorus]', '[[A0]]', '[1:2:3]'])('does not match %s', marker => {
    expect(whole.test(marker)).toBe(false);
  });
});
