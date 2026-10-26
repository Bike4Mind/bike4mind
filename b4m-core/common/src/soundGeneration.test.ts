import { describe, expect, it } from 'vitest';
import { SOUND_EFFECTS_MAX_INPUT_CHARS, soundEffectsRequestSchema } from './soundGeneration';

describe('soundEffectsRequestSchema text bound', () => {
  const textSchema = soundEffectsRequestSchema.shape.text;

  it('caps the prompt at the 450 characters ElevenLabs accepts', () => {
    expect(SOUND_EFFECTS_MAX_INPUT_CHARS).toBe(450);
  });

  it('accepts exactly 450 characters', () => {
    expect(textSchema.safeParse('x'.repeat(450)).success).toBe(true);
  });

  it('rejects 451 characters', () => {
    expect(textSchema.safeParse('x'.repeat(451)).success).toBe(false);
  });

  it('rejects an empty prompt', () => {
    expect(textSchema.safeParse('').success).toBe(false);
  });
});
