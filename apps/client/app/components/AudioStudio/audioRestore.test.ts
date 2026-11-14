import { describe, expect, it } from 'vitest';
import { TTS_DEFAULT_MODEL } from '@bike4mind/common';
import type { StudioRestoreRequest } from '@client/app/components/Studio/restore/studioRestore';
import { restoreAudioForm } from './audioRestore';

const restoreOf = (medium: 'speech' | 'sound-effects', request: Record<string, unknown>): StudioRestoreRequest => ({
  medium,
  request,
  lineageInputs: [],
  fileNames: {},
});

describe('restoreAudioForm: speech', () => {
  it('fills the text, provider, voice, format and language of a stored speech request', () => {
    const { value, notices } = restoreAudioForm(
      restoreOf('speech', {
        provider: 'elevenlabs',
        text: 'Hello there',
        model: TTS_DEFAULT_MODEL.elevenlabs,
        voice: 'voice-123',
        format: 'mp3',
        languageCode: 'fr',
      }),
      'tts',
      ['openai', 'elevenlabs']
    );
    expect(value).toEqual({
      text: 'Hello there',
      settings: { ttsProvider: 'elevenlabs', voice: 'voice-123', format: 'mp3', languageCode: 'fr' },
    });
    expect(notices).toEqual([]);
  });

  it('keeps the current voice settings when the provider is no longer usable, and says so', () => {
    const { value, notices } = restoreAudioForm(
      restoreOf('speech', { provider: 'elevenlabs', text: 'Hi', voice: 'voice-123' }),
      'tts',
      ['openai']
    );
    expect(value).toEqual({ text: 'Hi', settings: {} });
    expect(notices).toEqual(['ElevenLabs is no longer available to you, so the voice settings were left as they are.']);
  });

  it('falls back to mp3 for a format the provider no longer produces, and names settings Studio does not set', () => {
    const { value, notices } = restoreAudioForm(
      restoreOf('speech', { provider: 'elevenlabs', text: 'Hi', format: 'flac', model: 'tts-legacy', stability: 0.4 }),
      'tts',
      ['elevenlabs']
    );
    expect(value.settings).toMatchObject({ ttsProvider: 'elevenlabs', format: 'mp3', voice: '', languageCode: '' });
    expect(notices).toEqual([
      `Studio speaks with ${TTS_DEFAULT_MODEL.elevenlabs}; the take used tts-legacy.`,
      "Studio does not set stability or similarity, so the provider's defaults are used.",
      'ElevenLabs no longer produces flac, so mp3 is used.',
    ]);
  });
});

describe('restoreAudioForm: sound effects', () => {
  it('fills the text, length and prompt influence of a stored sound-effect request', () => {
    const { value, notices } = restoreAudioForm(
      restoreOf('sound-effects', {
        provider: 'elevenlabs',
        text: 'rain on a tin roof',
        durationSeconds: 4,
        promptInfluence: 0.7,
      }),
      'sound-effects',
      []
    );
    expect(value).toEqual({ text: 'rain on a tin roof', settings: { durationSeconds: 4, promptInfluence: 0.7 } });
    expect(notices).toEqual([]);
  });

  it('falls back from a length that is no longer valid, with a notice', () => {
    const { value, notices } = restoreAudioForm(
      restoreOf('sound-effects', { text: 'boom', durationSeconds: 90 }),
      'sound-effects',
      []
    );
    expect(value.settings).toEqual({ durationSeconds: null });
    expect(notices).toEqual(["The take's duration (90) is no longer valid, so the default is used."]);
  });

  it('names a stored format that Studio does not set for sound effects', () => {
    const { notices } = restoreAudioForm(
      restoreOf('sound-effects', { text: 'boom', format: 'mp3_44100_128' }),
      'sound-effects',
      []
    );
    expect(notices).toEqual(["Studio does not set a sound effect's format, so the default is used."]);
  });
});
