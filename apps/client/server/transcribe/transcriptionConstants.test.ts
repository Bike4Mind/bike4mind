import { describe, expect, it } from 'vitest';
import { TRANSCRIPTION_MAX_BYTES, TRANSCRIPTION_MIME_TYPES } from '@bike4mind/common';
import { speechToTextService } from '@bike4mind/services';

// common cannot import services, so schemas/transcriptionPublic.ts duplicates these.
describe('public transcription limits', () => {
  it('match the speech service allowlist and size cap', () => {
    expect([...TRANSCRIPTION_MIME_TYPES]).toEqual([...speechToTextService.ALLOWED_AUDIO_MIME_TYPES]);
    expect(TRANSCRIPTION_MAX_BYTES).toBe(speechToTextService.MAX_TRANSCRIBE_BYTES);
  });
});
