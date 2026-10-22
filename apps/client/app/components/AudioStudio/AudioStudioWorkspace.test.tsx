import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { estimateTtsCreditCost, TTS_DEFAULT_MODEL } from '@bike4mind/common';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { useAudioProvidersMock, useGenerateAudioMock, generate, hookState } = vi.hoisted(() => ({
  useAudioProvidersMock: vi.fn(),
  useGenerateAudioMock: vi.fn(),
  generate: vi.fn(),
  hookState: { result: null as null | { url: string; saved: boolean }, isGenerating: false },
}));

const settings = vi.hoisted(() => ({ enforceCredits: true }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? settings.enforceCredits : undefined),
}));
vi.mock('@client/app/hooks/data/audioProviders', () => ({ useAudioProviders: useAudioProvidersMock }));
vi.mock('./useGenerateAudio', () => ({ useGenerateAudio: useGenerateAudioMock }));
vi.mock('@client/app/components/Session/AISettings/AudioGenerationSettings', () => ({
  AudioGenerationSettings: ({ mode }: { mode: string }) => <div data-testid={`settings-${mode}`} />,
}));

import { SoundEffectsStudioWorkspace, SpeechStudioWorkspace } from './AudioStudioWorkspace';
import { useAudioGenSettings } from '@client/app/stores/useAudioGenSettings';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useAudioStudioDraft } from './useAudioStudioDraft';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWithTheme = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const providers = (speech: string[], soundEffects: string[]) =>
  useAudioProvidersMock.mockReturnValue({ isPending: false, data: { speech, soundEffects } });

beforeEach(() => {
  vi.clearAllMocks();
  hookState.result = null;
  hookState.isGenerating = false;
  settings.enforceCredits = true;
  useSelectedAccount.setState({ selectedAccount: null });
  // Read through on each call: the tests below set hookState just before rendering.
  useGenerateAudioMock.mockImplementation(() => ({
    generate,
    isGenerating: hookState.isGenerating,
    result: hookState.result,
  }));
  useAudioStudioDraft.setState({ text: { tts: '', 'sound-effects': '' } });
  useAudioGenSettings.getState().reset();
  providers(['openai'], ['elevenlabs']);
});

describe('AudioStudioWorkspace gate', () => {
  it('waits for the providers', () => {
    useAudioProvidersMock.mockReturnValue({ isPending: true, data: undefined });
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    expect(screen.getByTestId('speech-studio-loading')).toBeInTheDocument();
  });

  it('says sound effects are unavailable without a sound-effect provider, while speech stays usable', () => {
    providers(['openai'], []);
    renderWithTheme(<SoundEffectsStudioWorkspace testId="sound-effects-studio" />);
    expect(screen.getByTestId('sound-effects-studio-empty')).toHaveTextContent(
      'Sound effect generation is not available for your account yet.'
    );

    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    expect(screen.getByTestId('speech-studio-form')).toBeInTheDocument();
  });

  it('renders each tab with its own settings', () => {
    renderWithTheme(<SoundEffectsStudioWorkspace testId="sound-effects-studio" />);
    expect(screen.getByTestId('settings-sound-effects')).toBeInTheDocument();
  });

  it('says why when the providers could not be loaded', () => {
    useAudioProvidersMock.mockReturnValue({ isPending: false, data: undefined });
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    expect(screen.getByTestId('speech-studio-error')).toHaveTextContent(
      'Could not load the speech providers. Refresh to try again.'
    );
  });
});

describe('AudioStudioWorkspace form', () => {
  it('generates from the typed text and keeps it for another take', () => {
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    const submit = screen.getByTestId('speech-studio-submit-btn');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('speech-studio-text-input').querySelector('textarea')!, {
      target: { value: 'Hello there' },
    });
    fireEvent.click(submit);

    expect(generate).toHaveBeenCalledWith('Hello there');
    expect(useAudioStudioDraft.getState().text.tts).toBe('Hello there');
  });

  it('estimates credits the way the server preflight does, live as the text and provider change', () => {
    const shownCredits = () =>
      Number(screen.getByTestId('speech-studio-credit-estimate').textContent?.match(/~(\d+)/)?.[1]);
    const text = 'x'.repeat(3000);
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);

    fireEvent.change(screen.getByTestId('speech-studio-text-input').querySelector('textarea')!, {
      target: { value: text },
    });
    expect(shownCredits()).toBe(estimateTtsCreditCost('openai', TTS_DEFAULT_MODEL.openai, text.length));

    act(() => useAudioGenSettings.getState().setTtsProvider('elevenlabs'));
    expect(shownCredits()).toBe(estimateTtsCreditCost('elevenlabs', TTS_DEFAULT_MODEL.elevenlabs, text.length));
  });

  it('plays a result Files could not keep, since it will not appear in the gallery', () => {
    hookState.result = { url: 'blob:audio', saved: false };
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    expect(screen.getByTestId('speech-studio-player')).toHaveAttribute('src', 'blob:audio');
  });

  it('drives the sound-effects form in its own mode', () => {
    renderWithTheme(<SoundEffectsStudioWorkspace testId="sound-effects-studio" />);
    fireEvent.change(screen.getByTestId('sound-effects-studio-text-input').querySelector('textarea')!, {
      target: { value: 'rain on a tin roof' },
    });
    fireEvent.click(screen.getByTestId('sound-effects-studio-submit-btn'));

    expect(useGenerateAudioMock).toHaveBeenCalledWith('sound-effects');
    expect(generate).toHaveBeenCalledWith('rain on a tin roof');
  });

  it('leaves a saved result to the gallery', () => {
    hookState.result = { url: 'blob:audio', saved: true };
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    expect(screen.queryByTestId('speech-studio-player')).not.toBeInTheDocument();
  });
});

describe('AudioStudioWorkspace payer note', () => {
  const select = (name: string, personal: boolean) =>
    useSelectedAccount.setState({ selectedAccount: { id: 'acct-1', name, personal, credits: 100 } });

  it('names the selected organization', () => {
    select('Acme', false);
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    expect(screen.getByTestId('audio-form-payer-note')).toHaveTextContent('Paid from Acme credits');
  });

  it('names personal credits when no organization is selected', () => {
    select('Me', true);
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    expect(screen.getByTestId('audio-form-payer-note')).toHaveTextContent('Paid from your personal credits');
  });

  it('is hidden with no selection or when credits are not enforced', () => {
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    expect(screen.queryByTestId('audio-form-payer-note')).not.toBeInTheDocument();

    settings.enforceCredits = false;
    select('Acme', false);
    renderWithTheme(<SoundEffectsStudioWorkspace testId="sound-effects-studio" />);
    expect(screen.queryByTestId('audio-form-payer-note')).not.toBeInTheDocument();
  });
});
