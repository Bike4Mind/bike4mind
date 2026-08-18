import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MUSIC_LENGTH_MS,
  DEFAULT_MUSIC_MODEL_ID,
  MAX_MUSIC_LENGTH_MS,
  MIN_MUSIC_LENGTH_MS,
  musicRequestSchema,
} from './musicGeneration';

describe('musicRequestSchema', () => {
  it('defaults provider, length, and model so a prompt-only body is billable', () => {
    // The reserve/settle path needs a deterministic length before generation, so
    // an omitted lengthMs must resolve to a concrete number, not stay undefined.
    expect(musicRequestSchema.parse({ prompt: 'lofi beat' })).toEqual({
      provider: 'elevenlabs',
      prompt: 'lofi beat',
      lengthMs: DEFAULT_MUSIC_LENGTH_MS,
      modelId: DEFAULT_MUSIC_MODEL_ID,
    });
  });

  it('accepts the length bounds inclusively and rejects one step outside either', () => {
    expect(musicRequestSchema.parse({ prompt: 'x', lengthMs: MIN_MUSIC_LENGTH_MS }).lengthMs).toBe(MIN_MUSIC_LENGTH_MS);
    expect(musicRequestSchema.parse({ prompt: 'x', lengthMs: MAX_MUSIC_LENGTH_MS }).lengthMs).toBe(MAX_MUSIC_LENGTH_MS);
    expect(musicRequestSchema.safeParse({ prompt: 'x', lengthMs: MIN_MUSIC_LENGTH_MS - 1 }).success).toBe(false);
    // The cap exists so we never accept a length that would predictably outlive the
    // provider-fetch budget; raising it silently is the regression to catch.
    expect(musicRequestSchema.safeParse({ prompt: 'x', lengthMs: MAX_MUSIC_LENGTH_MS + 1 }).success).toBe(false);
  });

  it('caps length below the serving function budget', () => {
    expect(MAX_MUSIC_LENGTH_MS).toBe(120_000);
  });

  it('rejects a non-integer length', () => {
    expect(musicRequestSchema.safeParse({ prompt: 'x', lengthMs: 10_000.5 }).success).toBe(false);
  });

  it('preserves forceInstrumental: false instead of dropping it', () => {
    // false is meaningfully different from absent: it tells the provider to allow
    // vocals. A falsy-drop would silently change what the caller asked for.
    expect(musicRequestSchema.parse({ prompt: 'x', forceInstrumental: false })).toMatchObject({
      forceInstrumental: false,
    });
  });

  it('rejects an empty or over-long prompt', () => {
    expect(musicRequestSchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(musicRequestSchema.safeParse({ prompt: 'a'.repeat(2001) }).success).toBe(false);
  });

  it('rejects an unknown provider or model', () => {
    expect(musicRequestSchema.safeParse({ prompt: 'x', provider: 'suno' }).success).toBe(false);
    expect(musicRequestSchema.safeParse({ prompt: 'x', modelId: 'music_v2' }).success).toBe(false);
  });
});
