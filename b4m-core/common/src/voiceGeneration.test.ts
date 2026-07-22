import { describe, it, expect } from 'vitest';
import {
  VOICE_VENDOR_SUPPORTED_FORMATS,
  voiceOutputFormatSchema,
  supportedVoiceGenerationVendor,
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
