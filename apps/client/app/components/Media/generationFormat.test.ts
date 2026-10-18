import { describe, expect, it } from 'vitest';
import { formatSecondsClock, stripLyricTimestamps } from './generationFormat';

describe('formatSecondsClock', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(formatSecondsClock(125.4)).toBe('2:05');
    expect(formatSecondsClock(9.6)).toBe('0:10');
    expect(formatSecondsClock(59.6)).toBe('1:00');
    expect(formatSecondsClock(30.772166666666667)).toBe('0:31');
  });
});

describe('stripLyricTimestamps', () => {
  it('drops a leading [start:end] stamp on every line and keeps section tags', () => {
    expect(stripLyricTimestamps('[Verse]\n[3.4:6.9] windows down\n[7:12.25]  summer air')).toBe(
      '[Verse]\nwindows down\nsummer air'
    );
  });

  it('drops a line that holds only a stamp rather than leaving a blank line', () => {
    expect(stripLyricTimestamps('[1.0:2.0] One\n[2.0:3.0]\n[3.0:4.0] Two')).toBe('One\nTwo');
  });

  it('leaves lyrics without stamps, and brackets mid-line, unchanged', () => {
    const lyrics = '[Chorus 2]\nhold on [x2]\n12:30 at night';
    expect(stripLyricTimestamps(lyrics)).toBe(lyrics);
  });
});
