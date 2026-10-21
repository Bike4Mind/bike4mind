import { describe, it, expect } from 'vitest';
import {
  VOICE_VENDOR_SUPPORTED_FORMATS,
  voiceOutputFormatSchema,
  supportedVoiceGenerationVendor,
  ttsBase64ResponseSchema,
  ttsRequestSchema,
} from './voiceGeneration';

describe('VOICE_VENDOR_SUPPORTED_FORMATS', () => {
  it('lists a supported-format set for every vendor', () => {
    for (const vendor of supportedVoiceGenerationVendor.options) {
      expect(VOICE_VENDOR_SUPPORTED_FORMATS[vendor].length).toBeGreaterThan(0);
    }
  });

  it('only references formats in the output-format enum', () => {
    const valid = new Set(voiceOutputFormatSchema.options);
    for (const formats of Object.values(VOICE_VENDOR_SUPPORTED_FORMATS)) {
      for (const format of formats) expect(valid.has(format)).toBe(true);
    }
  });

  it('includes mp3 for every vendor (the universal default)', () => {
    for (const formats of Object.values(VOICE_VENDOR_SUPPORTED_FORMATS)) {
      expect(formats).toContain('mp3');
    }
  });

  it('excludes the formats ElevenLabs cannot produce', () => {
    // Guards the /api/ai/tts fail-fast path: these must be rejected with a 422,
    // not passed through to a mid-synthesis error. Keep in sync with
    // ELEVENLABS_OUTPUT_FORMAT in ElevenLabsVoiceService.
    expect(VOICE_VENDOR_SUPPORTED_FORMATS.elevenlabs).not.toContain('flac');
    expect(VOICE_VENDOR_SUPPORTED_FORMATS.elevenlabs).not.toContain('wav');
    expect(VOICE_VENDOR_SUPPORTED_FORMATS.elevenlabs).not.toContain('aac');
  });
});

describe('ttsRequestSchema languageCode', () => {
  it('accepts a lowercase ISO 639-1 code and passes it through unchanged', () => {
    for (const code of ['en', 'ja', 'pt']) {
      expect(ttsRequestSchema.parse({ text: 'hi', languageCode: code }).languageCode).toBe(code);
    }
  });

  it('stays optional', () => {
    expect(ttsRequestSchema.parse({ text: 'hi' }).languageCode).toBeUndefined();
  });

  it('rejects anything that is not a two-letter code', () => {
    // Fails locally rather than costing an ElevenLabs round-trip.
    for (const code of ['english', 'en-US', 'EN', 'e', 'en ', '', 'eng']) {
      expect(ttsRequestSchema.safeParse({ text: 'hi', languageCode: code }).success).toBe(false);
    }
  });

  it('names the offending field so the client error is actionable', () => {
    const result = ttsRequestSchema.safeParse({ text: 'hi', languageCode: 'english' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['languageCode']);
      expect(result.error.issues[0].message).toMatch(/ISO 639-1/);
    }
  });
});

describe('ttsBase64ResponseSchema', () => {
  const metadata = { format: 'mp3', contentType: 'audio/mpeg' };

  it('parses a url-delivery body', () => {
    const body = { ...metadata, delivery: 'url', url: 'https://s3/audio.mp3', bytes: 5_000_000 };
    expect(ttsBase64ResponseSchema.parse(body)).toMatchObject({ delivery: 'url', url: body.url, bytes: body.bytes });
  });

  it('parses a legacy inline body that predates `delivery`', () => {
    const parsed = ttsBase64ResponseSchema.parse({ ...metadata, audio: 'AAA=' });
    expect(parsed).toMatchObject({ audio: 'AAA=' });
    expect('delivery' in parsed ? parsed.delivery : undefined).toBeUndefined();
  });

  it('rejects a url-delivery body without `bytes`', () => {
    expect(ttsBase64ResponseSchema.safeParse({ ...metadata, delivery: 'url', url: 'https://s3/audio.mp3' }).success).toBe(
      false
    );
  });
});
