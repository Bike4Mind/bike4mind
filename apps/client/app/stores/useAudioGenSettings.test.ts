import { describe, it, expect, beforeEach } from 'vitest';
import { useAudioGenSettings } from './useAudioGenSettings';

describe('useAudioGenSettings', () => {
  beforeEach(() => {
    useAudioGenSettings.getState().reset();
  });

  it('defaults to an OpenAI/mp3 config and no cloned backend prefs', () => {
    const state = useAudioGenSettings.getState();
    expect(state.ttsProvider).toBe('openai');
    expect(state.format).toBe('mp3');
    // Empty voice => "resolve from the user's preferredVoice at send time".
    expect(state.voice).toBe('');
    // null duration => let the provider auto-select.
    expect(state.durationSeconds).toBeNull();
  });

  it('updates individual fields through their setters', () => {
    const { setTtsProvider, setVoice, setDurationSeconds } = useAudioGenSettings.getState();
    setTtsProvider('elevenlabs');
    setVoice('echo');
    setDurationSeconds(12);

    const state = useAudioGenSettings.getState();
    expect(state.ttsProvider).toBe('elevenlabs');
    expect(state.voice).toBe('echo');
    expect(state.durationSeconds).toBe(12);
  });

  it('applySettings() restores several selections and leaves the rest alone', () => {
    useAudioGenSettings.getState().setPromptInfluence(0.8);
    useAudioGenSettings.getState().applySettings({ ttsProvider: 'elevenlabs', format: 'opus', languageCode: 'ja' });

    expect(useAudioGenSettings.getState()).toMatchObject({
      ttsProvider: 'elevenlabs',
      format: 'opus',
      languageCode: 'ja',
      promptInfluence: 0.8,
    });
  });

  it('reset() restores defaults', () => {
    const { setVoice, reset } = useAudioGenSettings.getState();
    setVoice('shimmer');
    reset();

    expect(useAudioGenSettings.getState().voice).toBe('');
  });

  it('drops the retired mode from settings persisted by v1', async () => {
    const migrate = useAudioGenSettings.persist.getOptions().migrate;
    const migrated = await migrate?.({ mode: 'sound-effects', ttsProvider: 'elevenlabs' }, 1);
    expect(migrated).toEqual({ ttsProvider: 'elevenlabs' });
  });
});
