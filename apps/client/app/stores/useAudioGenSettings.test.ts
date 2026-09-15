import { describe, it, expect, beforeEach } from 'vitest';
import { useAudioGenSettings } from './useAudioGenSettings';

describe('useAudioGenSettings', () => {
  beforeEach(() => {
    useAudioGenSettings.getState().reset();
  });

  it('defaults to text-to-speech with an OpenAI/mp3 config and no cloned backend prefs', () => {
    const state = useAudioGenSettings.getState();
    expect(state.mode).toBe('tts');
    expect(state.ttsProvider).toBe('openai');
    expect(state.format).toBe('mp3');
    // Empty voice => "resolve from the user's preferredVoice at send time".
    expect(state.voice).toBe('');
    // null duration => let the provider auto-select.
    expect(state.durationSeconds).toBeNull();
  });

  it('updates individual fields through their setters', () => {
    const { setMode, setTtsProvider, setVoice, setDurationSeconds } = useAudioGenSettings.getState();
    setMode('sound-effects');
    setTtsProvider('elevenlabs');
    setVoice('echo');
    setDurationSeconds(12);

    const state = useAudioGenSettings.getState();
    expect(state.mode).toBe('sound-effects');
    expect(state.ttsProvider).toBe('elevenlabs');
    expect(state.voice).toBe('echo');
    expect(state.durationSeconds).toBe(12);
  });

  it('reset() restores defaults', () => {
    const { setMode, setVoice, reset } = useAudioGenSettings.getState();
    setMode('sound-effects');
    setVoice('shimmer');
    reset();

    const state = useAudioGenSettings.getState();
    expect(state.mode).toBe('tts');
    expect(state.voice).toBe('');
  });
});
