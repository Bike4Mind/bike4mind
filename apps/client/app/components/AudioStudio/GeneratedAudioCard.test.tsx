import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IFabFileDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const { setOpen, toastSuccess } = vi.hoisted(() => ({ setOpen: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }));
vi.mock('@client/app/components/Files/fileBrowserStore', () => ({
  useFileBrowser: (select: (state: { setOpen: typeof setOpen }) => unknown) => select({ setOpen }),
}));
vi.mock('@client/app/components/Media/MediaPlayer', () => ({
  MediaPlayer: ({ file }: { file: { id: string } }) => <div data-testid="media-player" data-file-id={file.id} />,
}));

import { useAudioGenSettings } from '@client/app/stores/useAudioGenSettings';
import GeneratedAudioCard from './GeneratedAudioCard';
import { useAudioStudioDraft } from './useAudioStudioDraft';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWithTheme = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

// Only the fields the card reads; the rest of a FabFile document is irrelevant here.
const speechFile = (generation?: Record<string, unknown>) =>
  ({
    id: 'fab-1',
    fileName: 'speech-hello-1.mp3',
    mimeType: 'audio/mpeg',
    createdAt: new Date('2026-10-15T10:00:00Z'),
    sourceMetadata: generation ? { generation } : undefined,
  }) as unknown as IFabFileDocument;

beforeEach(() => {
  vi.clearAllMocks();
  useAudioGenSettings.getState().reset();
  useAudioStudioDraft.setState({ text: { tts: '', 'sound-effects': '' } });
});

describe('GeneratedAudioCard', () => {
  const generation = {
    generator: 'speech',
    provider: 'elevenlabs',
    prompt: 'Hello there',
    voice: 'v-1',
    format: 'opus',
    languageCode: 'ja',
  };

  it('plays the saved file and summarizes how it was made', () => {
    renderWithTheme(<GeneratedAudioCard mode="tts" file={speechFile(generation)} />);
    expect(screen.getByTestId('media-player')).toHaveAttribute('data-file-id', 'fab-1');
    expect(screen.getByTestId('generated-audio-card-settings')).toHaveTextContent('ElevenLabs, v-1, opus, ja');
    expect(screen.getByTestId('generated-audio-card-prompt')).toHaveTextContent('Hello there');
  });

  it('copies its settings and text into the form', () => {
    renderWithTheme(<GeneratedAudioCard mode="tts" file={speechFile(generation)} />);
    fireEvent.click(screen.getByTestId('generated-audio-card-reuse-btn'));

    expect(useAudioGenSettings.getState()).toMatchObject({
      ttsProvider: 'elevenlabs',
      voice: 'v-1',
      format: 'opus',
      languageCode: 'ja',
    });
    expect(useAudioStudioDraft.getState().text.tts).toBe('Hello there');
  });

  it('opens Files', () => {
    renderWithTheme(<GeneratedAudioCard mode="tts" file={speechFile(generation)} />);
    fireEvent.click(screen.getByTestId('generated-audio-card-open-files-btn'));
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it('copies only the settings from a file whose text was too long to keep', () => {
    renderWithTheme(<GeneratedAudioCard mode="tts" file={speechFile({ ...generation, promptTruncated: true })} />);
    fireEvent.click(screen.getByTestId('generated-audio-card-reuse-btn'));

    expect(useAudioGenSettings.getState()).toMatchObject({ ttsProvider: 'elevenlabs', format: 'opus' });
    expect(useAudioStudioDraft.getState().text.tts).toBe('');
    expect(toastSuccess).toHaveBeenCalledWith('Settings copied. The text was too long to keep, so paste it in again.');
  });

  it('still plays a file with no recorded generation, without offering to reuse it', () => {
    renderWithTheme(<GeneratedAudioCard mode="tts" file={speechFile()} />);
    expect(screen.getByTestId('media-player')).toBeInTheDocument();
    expect(screen.getByTestId('generated-audio-card-settings')).toHaveTextContent('speech-hello-1.mp3');
    expect(screen.queryByTestId('generated-audio-card-reuse-btn')).not.toBeInTheDocument();
  });
});
