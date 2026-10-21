import { describe, expect, it } from 'vitest';
import {
  ELEVENLABS_AUDIO_CONTENT_TYPES,
  elevenLabsContentTypeForFormat,
  isSupportedElevenLabsFormat,
} from './elevenLabsAudioFormat';
import { extensionFromMimeType } from './utils';

describe('elevenLabsContentTypeForFormat', () => {
  it.each([
    ['mp3_44100_128', 'audio/mpeg'],
    ['opus_48000_128', 'audio/opus'],
    ['pcm_44100', 'audio/L16'],
    ['ulaw_8000', 'audio/basic'],
  ])('maps %s to %s', (format, expected) => {
    expect(elevenLabsContentTypeForFormat(format)).toBe(expected);
  });

  it.each(['alaw_8000', 'mp3extra_44100', 'toString', 'constructor_1', ''])(
    'refuses %j rather than guessing a MIME type',
    format => {
      expect(elevenLabsContentTypeForFormat(format)).toBeUndefined();
      expect(isSupportedElevenLabsFormat(format)).toBe(false);
    }
  );

  it('publishes exactly the content types it can map to', () => {
    expect(ELEVENLABS_AUDIO_CONTENT_TYPES).toEqual(['audio/mpeg', 'audio/opus', 'audio/L16', 'audio/basic']);
  });

  it.each(ELEVENLABS_AUDIO_CONTENT_TYPES)('resolves a file extension for %s, so the saved copy is not a .bin', type => {
    expect(extensionFromMimeType(type)).toBeDefined();
  });
});
