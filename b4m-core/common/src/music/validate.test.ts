import { describe, expect, it } from 'vitest';
import type { MusicGenerationRequest } from './request';
import type { MusicModelCapabilities } from './types';
import { validateMusicRequest } from './validate';

const caps = (overrides: Partial<MusicModelCapabilities> = {}): MusicModelCapabilities => ({
  provider: 'test',
  displayName: 'Model',
  vocals: 'optional',
  lyrics: { maxChars: 50 },
  duration: { control: 'exact', min: 3, max: 60, default: 20 },
  outputFormats: ['mp3'],
  typicalRenderSeconds: 1,
  pricing: { unit: 'per_second', usd: 0.01 },
  preview: false,
  defaultEnabled: true,
  ...overrides,
});
const base: MusicGenerationRequest = { model: 'test-music', prompt: 'a song' };

const codeOf = (request: MusicGenerationRequest, capabilities = caps()) => {
  const result = validateMusicRequest(request, capabilities);
  return result.ok ? 'ok' : result.code;
};

describe('validateMusicRequest', () => {
  it('resolves the default length and vocals', () => {
    const result = validateMusicRequest(base, caps());
    expect(result).toMatchObject({ ok: true, request: { durationSeconds: 20, instrumental: false } });
  });

  it('keeps an in-range length and rejects one outside the range without clamping', () => {
    expect(validateMusicRequest({ ...base, durationSeconds: 60 }, caps())).toMatchObject({
      ok: true,
      request: { durationSeconds: 60 },
    });
    expect(codeOf({ ...base, durationSeconds: 2 })).toBe('duration_out_of_range');
    expect(codeOf({ ...base, durationSeconds: 61 })).toBe('duration_out_of_range');
  });

  it('accepts a fixed-length model with the length omitted or repeated, and nothing else', () => {
    const fixed = caps({ duration: { control: 'fixed', seconds: 30 } });
    expect(validateMusicRequest(base, fixed)).toMatchObject({ ok: true, request: { durationSeconds: 30 } });
    expect(codeOf({ ...base, durationSeconds: 30 }, fixed)).toBe('ok');
    expect(codeOf({ ...base, durationSeconds: 20 }, fixed)).toBe('duration_out_of_range');
  });

  it('rejects lyrics the model cannot sing', () => {
    expect(codeOf({ ...base, lyrics: 'la la' }, caps({ lyrics: null }))).toBe('lyrics_not_supported');
    expect(codeOf({ ...base, lyrics: 'la la', instrumental: true })).toBe('lyrics_with_instrumental');
    expect(codeOf({ ...base, lyrics: 'x'.repeat(51) })).toBe('lyrics_too_long');
    expect(codeOf({ ...base, lyrics: 'x'.repeat(50) })).toBe('ok');
  });

  it('enforces a per-line lyric cap', () => {
    const lined = caps({ lyrics: { maxChars: 100, maxLineChars: 10 } });
    expect(codeOf({ ...base, lyrics: 'short\nalso short' }, lined)).toBe('ok');
    expect(codeOf({ ...base, lyrics: 'short\nthis line is too long' }, lined)).toBe('lyrics_too_long');
  });

  it('defaults an instrumental-only model to instrumental and refuses vocals', () => {
    const instrumentalOnly = caps({ vocals: 'never' });
    expect(validateMusicRequest(base, instrumentalOnly)).toMatchObject({ ok: true, request: { instrumental: true } });
    expect(codeOf({ ...base, instrumental: false }, instrumentalOnly)).toBe('vocals_not_supported');
  });
});
