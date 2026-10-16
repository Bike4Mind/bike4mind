import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useAudioGenSettings } from '@client/app/stores/useAudioGenSettings';
import { AudioGenerationSettings } from './AudioGenerationSettings';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderSettings = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AudioGenerationSettings mode="tts" />
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
 * OpenAI -> ElevenLabs on purpose: the voice picker is unmounted for ElevenLabs, so the store
 * value can only change because the provider switch cleared it.
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
