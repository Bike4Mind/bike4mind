import { describe, it, expect } from 'vitest';
import { isAudioMimeType, isStorableFabFileMimeType, isSupportedFabFileMimeType } from './common';

describe('isAudioMimeType', () => {
  it('matches known and arbitrary audio subtypes', () => {
    expect(isAudioMimeType('audio/mpeg')).toBe(true);
    expect(isAudioMimeType('audio/wav')).toBe(true);
    expect(isAudioMimeType('audio/opus')).toBe(true);
    // Fails safe for any audio/* a provider might emit, not just the known set.
    expect(isAudioMimeType('audio/x-something-weird')).toBe(true);
  });

  it('ignores parameters and casing', () => {
    expect(isAudioMimeType('AUDIO/MPEG')).toBe(true);
    expect(isAudioMimeType('audio/wav; rate=44100')).toBe(true);
  });

  it('is false for non-audio and empty', () => {
    expect(isAudioMimeType('image/png')).toBe(false);
    expect(isAudioMimeType('text/plain')).toBe(false);
    expect(isAudioMimeType('')).toBe(false);
    expect(isAudioMimeType(undefined)).toBe(false);
    expect(isAudioMimeType(null)).toBe(false);
  });
});

describe('isStorableFabFileMimeType', () => {
  it('accepts audio even though it is not ingestable/vectorizable', () => {
    expect(isStorableFabFileMimeType('audio/mpeg')).toBe(true);
    // Guard the invariant: audio must never leak into the vectorizable set.
    expect(isSupportedFabFileMimeType('audio/mpeg')).toBe(false);
  });

  it('still accepts the ingestable types', () => {
    expect(isStorableFabFileMimeType('text/plain')).toBe(true);
    expect(isStorableFabFileMimeType('application/pdf')).toBe(true);
  });

  it('rejects genuinely unsupported binaries', () => {
    expect(isStorableFabFileMimeType('application/x-msdownload')).toBe(false);
    expect(isStorableFabFileMimeType('application/octet-stream')).toBe(false);
    expect(isStorableFabFileMimeType('')).toBe(false);
  });
});
