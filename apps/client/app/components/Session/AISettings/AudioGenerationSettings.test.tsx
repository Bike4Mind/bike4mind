import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useAudioGenSettings } from '@client/app/stores/useAudioGenSettings';
import { AudioGenerationSettings } from './AudioGenerationSettings';

const { useElevenLabsTtsVoicesMock } = vi.hoisted(() => ({
  useElevenLabsTtsVoicesMock: vi.fn(() => ({ data: [], isLoading: false, isError: false })),
}));
vi.mock('@client/app/hooks/data/ttsVoices', () => ({ useElevenLabsTtsVoices: useElevenLabsTtsVoicesMock }));

const appTheme = extendTheme({ ...getThemeConfig() });

const renderSettings = (mode?: 'tts') =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AudioGenerationSettings mode={mode} />
    </CssVarsProvider>
  );

const pickProvider = (label: string) => {
  // The select's testid sits on its root; the menu only opens from its combobox button.
  fireEvent.click(screen.getByRole('combobox', { name: 'Provider' }));
  fireEvent.click(screen.getByRole('option', { name: label }));
};

beforeEach(() => useAudioGenSettings.getState().reset());
afterEach(() => useAudioGenSettings.getState().reset());

/**
 * Switching provider is how a saved file's "use these settings" lands here: it restores the
 * file's provider AND its voice id. A voice id belongs to one vendor only, and the ElevenLabs
 * branch offers no picker to clear it, so a stale id must not survive the switch.
 *
 * OpenAI -> ElevenLabs in the settings modal on purpose: its voice picker is unmounted for
 * ElevenLabs, so the store value can only change because the provider switch cleared it.
 */
describe('AudioGenerationSettings provider switch', () => {
  it('drops the previous provider voice id instead of carrying it over', () => {
    useAudioGenSettings.setState({ ttsProvider: 'openai', voice: 'alloy' });

    renderSettings();
    pickProvider('ElevenLabs');

    expect(useAudioGenSettings.getState().ttsProvider).toBe('elevenlabs');
    expect(useAudioGenSettings.getState().voice).toBe('');
  });

  it('resets a format the new provider cannot produce to mp3, and keeps one it can', () => {
    useAudioGenSettings.setState({ ttsProvider: 'openai', format: 'flac' });
    renderSettings();
    pickProvider('ElevenLabs');
    expect(useAudioGenSettings.getState().format).toBe('mp3');

    useAudioGenSettings.setState({ ttsProvider: 'openai', format: 'opus' });
    pickProvider('ElevenLabs');
    expect(useAudioGenSettings.getState().format).toBe('opus');
  });
});

describe('AudioGenerationSettings voice picker', () => {
  it('lists every OpenAI voice with a sample in Studio, and selecting one sets the voice', () => {
    renderSettings('tts');

    expect(screen.queryByTestId('audio-gen-voice-select')).toBeNull();
    expect(screen.getByTestId('voice-sample-play-btn-alloy')).toBeTruthy();
    fireEvent.click(screen.getByTestId('voice-sample-select-btn-cedar'));
    expect(useAudioGenSettings.getState().voice).toBe('cedar');
  });

  it('keeps the compact dropdown in the settings modal', () => {
    renderSettings();

    expect(screen.getByTestId('audio-gen-voice-select')).toBeTruthy();
    expect(screen.queryByTestId('voice-sample-list')).toBeNull();
  });

  it('says when the modal synthesizes with an ElevenLabs voice picked in Studio, and resets it', () => {
    useAudioGenSettings.setState({ ttsProvider: 'elevenlabs', voice: 'v1' });
    renderSettings();

    expect(screen.getByText('ElevenLabs uses the voice picked in Studio.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('audio-gen-voice-reset-btn'));
    expect(useAudioGenSettings.getState().voice).toBe('');
    expect(screen.getByText('ElevenLabs uses the voice configured in your account settings.')).toBeTruthy();
  });
});
