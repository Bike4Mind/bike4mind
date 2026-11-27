import { z } from 'zod';
import type { SpeechWordTiming } from '@bike4mind/common';

/** ElevenLabs' per-character alignment of the input text (the `alignment` of a /with-timestamps response). */
export const CharacterAlignmentSchema = z.object({
  characters: z.array(z.string()),
  character_start_times_seconds: z.array(z.number()),
  character_end_times_seconds: z.array(z.number()),
});

export type CharacterAlignment = z.infer<typeof CharacterAlignmentSchema>;

const toMs = (seconds: number) => Math.max(0, Math.round(seconds * 1000));

/**
 * Folds character timings into word timings, a word being a run of non-whitespace characters, so the words line up
 * with a whitespace split of the input text. Undefined when the arrays disagree in length: a partial alignment
 * would time the wrong words, and callers can fall back to an estimate instead.
 */
export const wordTimingsFromCharacterAlignment = (alignment: CharacterAlignment): SpeechWordTiming[] | undefined => {
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  if (starts.length !== characters.length || ends.length !== characters.length) return undefined;
  const words: SpeechWordTiming[] = [];
  let current: SpeechWordTiming | undefined;
  characters.forEach((character, index) => {
    if (/^\s*$/.test(character)) {
      current = undefined;
      return;
    }
    if (!current) {
      current = { text: '', startMs: toMs(starts[index]), endMs: toMs(ends[index]) };
      words.push(current);
    }
    current.text += character;
    current.endMs = Math.max(current.endMs, toMs(ends[index]));
  });
  return words.length > 0 ? words : undefined;
};
