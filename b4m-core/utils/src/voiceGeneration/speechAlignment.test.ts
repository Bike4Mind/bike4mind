import { describe, expect, it } from 'vitest';
import { wordTimingsFromCharacterAlignment } from './speechAlignment';

const alignmentOf = (text: string, msPerChar = 100) => ({
  characters: [...text],
  character_start_times_seconds: [...text].map((_, index) => (index * msPerChar) / 1000),
  character_end_times_seconds: [...text].map((_, index) => ((index + 1) * msPerChar) / 1000),
});

describe('wordTimingsFromCharacterAlignment', () => {
  it('yields one timing per whitespace-separated word, punctuation included', () => {
    expect(wordTimingsFromCharacterAlignment(alignmentOf('Go,  now!\nok'))).toEqual([
      { text: 'Go,', startMs: 0, endMs: 300 },
      { text: 'now!', startMs: 500, endMs: 900 },
      { text: 'ok', startMs: 1000, endMs: 1200 },
    ]);
  });

  it('gives up on arrays of different lengths rather than time the wrong words', () => {
    const alignment = alignmentOf('Hello');
    expect(wordTimingsFromCharacterAlignment({ ...alignment, character_end_times_seconds: [0.1] })).toBeUndefined();
  });

  it('is undefined for an alignment of only whitespace', () => {
    expect(wordTimingsFromCharacterAlignment(alignmentOf('  '))).toBeUndefined();
  });
});
