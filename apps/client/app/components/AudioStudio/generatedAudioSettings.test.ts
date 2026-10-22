import { describe, it, expect } from 'vitest';
import { audioModeTag, readGeneration, settingsFromGeneration } from './generatedAudioSettings';

describe('audioModeTag', () => {
  it('matches the tag saveGeneratedAsset stamps on each kind of file', () => {
    expect(audioModeTag('tts')).toBe('speech');
    expect(audioModeTag('sound-effects')).toBe('sound-effect');
  });
});

describe('readGeneration', () => {
  it('reads the stamped generation', () => {
    const generation = { generator: 'speech', provider: 'openai', prompt: 'hi' };
    expect(readGeneration({ sourceMetadata: { generation } })).toEqual(generation);
  });

  it('is undefined for a file with no or a malformed generation', () => {
    expect(readGeneration({})).toBeUndefined();
    expect(readGeneration({ sourceMetadata: { generation: { generator: 'speech' } } })).toBeUndefined();
  });
});

describe('settingsFromGeneration', () => {
  it('restores every speech selection that was recorded', () => {
    expect(
      settingsFromGeneration({
        generator: 'speech',
        provider: 'elevenlabs',
        prompt: 'hi',
        voice: 'v-1',
        format: 'opus',
        languageCode: 'ja',
      })
    ).toEqual({ ttsProvider: 'elevenlabs', voice: 'v-1', format: 'opus', languageCode: 'ja' });
  });

  it('falls back to the form defaults for a speech file saved before settings were recorded', () => {
    expect(settingsFromGeneration({ generator: 'speech', provider: 'openai', prompt: 'hi' })).toEqual({
      ttsProvider: 'openai',
      voice: '',
      format: 'mp3',
      languageCode: '',
    });
  });

  it('never restores a format the provider cannot produce', () => {
    expect(
      settingsFromGeneration({ generator: 'speech', provider: 'elevenlabs', prompt: 'hi', format: 'flac' })
    ).toMatchObject({ format: 'mp3' });
  });

  it('restores nothing for a speech provider the form does not offer', () => {
    expect(settingsFromGeneration({ generator: 'speech', provider: 'someone-else', prompt: 'hi' })).toEqual({});
  });

  it('restores the sound-effect duration and prompt influence', () => {
    expect(
      settingsFromGeneration({
        generator: 'sound_effect',
        provider: 'elevenlabs',
        prompt: 'rain',
        durationSeconds: 4,
        promptInfluence: 0.7,
      })
    ).toEqual({ durationSeconds: 4, promptInfluence: 0.7 });
  });

  it('restores an automatic duration and keeps the current influence when none was recorded', () => {
    expect(settingsFromGeneration({ generator: 'sound_effect', provider: 'elevenlabs', prompt: 'rain' })).toEqual({
      durationSeconds: null,
    });
  });
});
