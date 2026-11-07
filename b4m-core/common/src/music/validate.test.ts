import { describe, expect, it } from 'vitest';
import type { MusicGenerationRequest } from './request';
import type { MusicModelCapabilities } from './types';
import { musicFailureReason, type MusicFailureDetail } from './reasons';
import { MUSIC_VALIDATION_ERROR_CODES, validateMusicRequest } from './validate';

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
    expect(codeOf({ ...base, durationSeconds: 2 })).toBe('unsupported_duration');
    expect(codeOf({ ...base, durationSeconds: 61 })).toBe('unsupported_duration');
  });

  it('accepts a fixed-length model with the length omitted or repeated, and nothing else', () => {
    const fixed = caps({ duration: { control: 'fixed', seconds: 30 } });
    expect(validateMusicRequest(base, fixed)).toMatchObject({ ok: true, request: { durationSeconds: 30 } });
    expect(codeOf({ ...base, durationSeconds: 30 }, fixed)).toBe('ok');
    expect(codeOf({ ...base, durationSeconds: 20 }, fixed)).toBe('unsupported_duration');
  });

  it('rejects lyrics the model cannot sing', () => {
    expect(codeOf({ ...base, lyrics: 'la la' }, caps({ lyrics: null }))).toBe('unsupported_lyrics');
    expect(codeOf({ ...base, lyrics: 'la la', instrumental: true })).toBe('lyrics_with_instrumental');
    expect(codeOf({ ...base, lyrics: 'x'.repeat(51) })).toBe('lyrics_too_long');
    expect(codeOf({ ...base, lyrics: 'x'.repeat(50) })).toBe('ok');
  });

  it('enforces a per-line lyric cap', () => {
    const lined = caps({ lyrics: { maxChars: 100, maxLineChars: 10 } });
    expect(codeOf({ ...base, lyrics: 'short\nalso short' }, lined)).toBe('ok');
    expect(codeOf({ ...base, lyrics: 'short\nthis line is too long' }, lined)).toBe('lyrics_too_long');
    // A CRLF line ending is not part of the line.
    expect(codeOf({ ...base, lyrics: 'ten chars!\r\nten chars!' }, lined)).toBe('ok');
  });

  it('defaults an instrumental-only model to instrumental and refuses vocals', () => {
    const instrumentalOnly = caps({ vocals: 'never' });
    expect(validateMusicRequest(base, instrumentalOnly)).toMatchObject({ ok: true, request: { instrumental: true } });
    expect(codeOf({ ...base, instrumental: false }, instrumentalOnly)).toBe('unsupported_vocals');
    expect(codeOf({ ...base, lyrics: 'la la' }, instrumentalOnly)).toBe('unsupported_lyrics');
  });
});

describe('validateMusicRequest why-not reasons', () => {
  const reasonOf = (request: MusicGenerationRequest, capabilities = caps()) => {
    const result = validateMusicRequest(request, capabilities);
    return result.ok ? null : result.reason;
  };

  it('names the model, its limit and the requested length', () => {
    expect(reasonOf({ ...base, durationSeconds: 61 })).toBe('Model supports up to 60s; you asked for 61s');
    expect(reasonOf({ ...base, durationSeconds: 2 })).toBe('Model supports at least 3s; you asked for 2s');
    expect(reasonOf({ ...base, durationSeconds: 45 }, caps({ duration: { control: 'fixed', seconds: 30 } }))).toBe(
      'Model makes 30s tracks only; you asked for 45s'
    );
  });

  it('reports the lyric length that broke the limit', () => {
    expect(reasonOf({ ...base, lyrics: 'x'.repeat(51) })).toBe(
      'Model takes up to 50 characters of lyrics; yours have 51'
    );
    const lineCapped = caps({ lyrics: { maxChars: 500, maxLineChars: 10 } });
    expect(reasonOf({ ...base, lyrics: 'short\nthis line is long' }, lineCapped)).toBe(
      'Model takes up to 10 characters per lyric line; your longest has 17'
    );
  });

  it('carries the typed detail the reason was built from', () => {
    expect(validateMusicRequest({ ...base, durationSeconds: 61 }, caps())).toMatchObject({
      ok: false,
      detail: { model: 'Model', code: 'unsupported_duration', requested: 61 },
    });
  });

  // One sample detail per code; the satisfies clause fails to compile when a code is added without one.
  const SAMPLES = {
    unsupported_duration: {
      model: 'Model',
      code: 'unsupported_duration',
      requested: 200,
      allowed: { control: 'approximate', min: 10, max: 180, default: 30 },
    },
    unsupported_lyrics: { model: 'Model', code: 'unsupported_lyrics' },
    unsupported_vocals: { model: 'Model', code: 'unsupported_vocals' },
    lyrics_with_instrumental: { model: 'Model', code: 'lyrics_with_instrumental' },
    lyrics_too_long: { model: 'Model', code: 'lyrics_too_long', limit: 'total', max: 3000, requested: 3500 },
  } satisfies { [C in MusicFailureDetail['code']]: Extract<MusicFailureDetail, { code: C }> };

  it.each(MUSIC_VALIDATION_ERROR_CODES)('has a short ASCII reason for %s', code => {
    const reason = musicFailureReason(SAMPLES[code]);
    expect(reason).toMatch(/^[\x20-\x7e]+$/);
    expect(reason.length).toBeLessThanOrEqual(120);
  });

  it('phrases each sample for a person, not a developer', () => {
    expect(musicFailureReason(SAMPLES.unsupported_duration)).toBe('Model supports up to 180s; you asked for 200s');
    expect(musicFailureReason(SAMPLES.unsupported_lyrics)).toBe('Model does not take custom lyrics');
    expect(musicFailureReason(SAMPLES.unsupported_vocals)).toBe('Model makes instrumental music only');
    expect(musicFailureReason(SAMPLES.lyrics_with_instrumental)).toBe('An instrumental track cannot have lyrics');
  });
});
