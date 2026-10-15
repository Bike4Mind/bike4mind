import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { useAudioProvidersMock, generate, hookState } = vi.hoisted(() => ({
  useAudioProvidersMock: vi.fn(),
  generate: vi.fn(),
  hookState: { result: null as null | { url: string; saved: boolean }, isGenerating: false },
}));

vi.mock('@client/app/hooks/data/audioProviders', () => ({ useAudioProviders: useAudioProvidersMock }));
vi.mock('./useGenerateAudio', () => ({
  useGenerateAudio: () => ({ generate, isGenerating: hookState.isGenerating, result: hookState.result }),
}));
vi.mock('@client/app/components/Session/AISettings/AudioGenerationSettings', () => ({
  AudioGenerationSettings: ({ mode }: { mode: string }) => <div data-testid={`settings-${mode}`} />,
}));

import { SoundEffectsStudioWorkspace, SpeechStudioWorkspace } from './AudioStudioWorkspace';
import { useAudioStudioDraft } from './useAudioStudioDraft';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWithTheme = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const providers = (speech: string[], soundEffects: string[]) =>
  useAudioProvidersMock.mockReturnValue({ isPending: false, data: { speech, soundEffects } });

beforeEach(() => {
  vi.clearAllMocks();
  hookState.result = null;
  hookState.isGenerating = false;
  useAudioStudioDraft.setState({ text: { tts: '', 'sound-effects': '' } });
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

  it('shows a live credit estimate', () => {
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    expect(screen.getByTestId('speech-studio-credit-estimate')).toHaveTextContent(/credits? estimated/);
  });

  it('plays a result Files could not keep, since it will not appear in the gallery', () => {
    hookState.result = { url: 'blob:audio', saved: false };
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    expect(screen.getByTestId('speech-studio-player')).toHaveAttribute('src', 'blob:audio');
  });

  it('leaves a saved result to the gallery', () => {
    hookState.result = { url: 'blob:audio', saved: true };
    renderWithTheme(<SpeechStudioWorkspace testId="speech-studio" />);
    expect(screen.queryByTestId('speech-studio-player')).not.toBeInTheDocument();
  });
});
