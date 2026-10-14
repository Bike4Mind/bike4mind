import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import MediaPlayer, { type MediaPlayerFile } from './MediaPlayer';

const { getFabFileByIdFromServer, downloadData } = vi.hoisted(() => ({
  getFabFileByIdFromServer: vi.fn(),
  downloadData: vi.fn(),
}));
vi.mock('@client/app/utils/filesAPICalls', () => ({ getFabFileByIdFromServer }));
vi.mock('@client/app/utils/download', () => ({ downloadData }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const HOUR_MS = 60 * 60 * 1000;
const makeFile = (overrides: Partial<MediaPlayerFile> = {}): MediaPlayerFile => ({
  id: 'file-1',
  fileName: 'song.mp3',
  mimeType: 'audio/mpeg',
  fileUrl: 'https://files.example.test/song.mp3?sig=old',
  fileUrlExpireAt: new Date(Date.now() + HOUR_MS),
  ...overrides,
});

const renderPlayer = (file: MediaPlayerFile, props: { hideDownload?: boolean; preload?: 'none' | 'metadata' } = {}) =>
  render(<MediaPlayer file={file} {...props} />, { wrapper: Wrapper });

describe('MediaPlayer', () => {
  beforeEach(() => {
    getFabFileByIdFromServer.mockReset();
    downloadData.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders an audio element for an audio file, with metadata preload by default', () => {
    renderPlayer(makeFile());
    const audio = screen.getByTestId('media-player-audio');
    expect(audio.tagName).toBe('AUDIO');
    expect(audio.getAttribute('src')).toBe('https://files.example.test/song.mp3?sig=old');
    expect(audio.getAttribute('preload')).toBe('metadata');
    expect(screen.queryByTestId('media-player-video')).toBeNull();
  });

  it('renders a video element for a video file', () => {
    renderPlayer(makeFile({ fileName: 'clip.mp4', mimeType: 'video/mp4' }));
    expect(screen.getByTestId('media-player-video').tagName).toBe('VIDEO');
  });

  it('honours preload none for long lists', () => {
    renderPlayer(makeFile(), { preload: 'none' });
    expect(screen.getByTestId('media-player-audio').getAttribute('preload')).toBe('none');
  });

  it('falls back to the presigned URL when there is no file URL', () => {
    renderPlayer(makeFile({ fileUrl: undefined, presignedUrl: 'https://files.example.test/p' }));
    expect(screen.getByTestId('media-player-audio').getAttribute('src')).toBe('https://files.example.test/p');
    expect(getFabFileByIdFromServer).not.toHaveBeenCalled();
  });

  it('does not re-sign a URL that is still fresh', () => {
    renderPlayer(makeFile());
    expect(getFabFileByIdFromServer).not.toHaveBeenCalled();
  });

  it('re-signs a URL that expires within five minutes, on mount', async () => {
    getFabFileByIdFromServer.mockResolvedValue({ fileUrl: 'https://files.example.test/song.mp3?sig=new' });
    renderPlayer(makeFile({ fileUrlExpireAt: new Date(Date.now() + 60 * 1000) }));
    await waitFor(() =>
      expect(screen.getByTestId('media-player-audio').getAttribute('src')).toBe(
        'https://files.example.test/song.mp3?sig=new'
      )
    );
    expect(getFabFileByIdFromServer).toHaveBeenCalledWith('file-1');
  });

  it('re-signs once when the element fails to load, then plays the new URL', async () => {
    getFabFileByIdFromServer.mockResolvedValue({ fileUrl: 'https://files.example.test/song.mp3?sig=new' });
    renderPlayer(makeFile());
    fireEvent.error(screen.getByTestId('media-player-audio'));
    await waitFor(() =>
      expect(screen.getByTestId('media-player-audio').getAttribute('src')).toBe(
        'https://files.example.test/song.mp3?sig=new'
      )
    );
    expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(1);
  });

  it('shows the error state when the re-signed URL fails too, without re-signing again', async () => {
    getFabFileByIdFromServer.mockResolvedValue({ fileUrl: 'https://files.example.test/song.mp3?sig=new' });
    renderPlayer(makeFile());
    fireEvent.error(screen.getByTestId('media-player-audio'));
    await waitFor(() => expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('media-player-audio').getAttribute('src')).toContain('sig=new'));
    fireEvent.error(screen.getByTestId('media-player-audio'));
    expect(await screen.findByTestId('media-player-error')).toBeTruthy();
    expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(1);
  });

  it('re-signs again after a successful load, so a second expiry is recovered too', async () => {
    getFabFileByIdFromServer
      .mockResolvedValueOnce({ fileUrl: 'https://files.example.test/a' })
      .mockResolvedValueOnce({ fileUrl: 'https://files.example.test/b' });
    renderPlayer(makeFile());
    fireEvent.error(screen.getByTestId('media-player-audio'));
    await waitFor(() => expect(screen.getByTestId('media-player-audio').getAttribute('src')).toContain('/a'));
    fireEvent.loadedMetadata(screen.getByTestId('media-player-audio'));
    fireEvent.error(screen.getByTestId('media-player-audio'));
    await waitFor(() => expect(screen.getByTestId('media-player-audio').getAttribute('src')).toContain('/b'));
    expect(screen.queryByTestId('media-player-error')).toBeNull();
  });

  it('shows the error state when re-signing fails, and retries on demand', async () => {
    getFabFileByIdFromServer.mockRejectedValueOnce(new Error('gone'));
    renderPlayer(makeFile());
    fireEvent.error(screen.getByTestId('media-player-audio'));
    expect(await screen.findByTestId('media-player-error')).toBeTruthy();

    getFabFileByIdFromServer.mockResolvedValueOnce({ fileUrl: 'https://files.example.test/back' });
    fireEvent.click(screen.getByTestId('media-player-retry-btn'));
    await waitFor(() => expect(screen.getByTestId('media-player-audio').getAttribute('src')).toContain('/back'));
  });

  it('downloads the current file as a blob under its file name', async () => {
    const blob = new Blob(['mp3']);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    vi.stubGlobal('fetch', fetchMock);
    renderPlayer(makeFile());
    await act(async () => {
      fireEvent.click(screen.getByTestId('media-player-download-btn'));
    });
    expect(fetchMock).toHaveBeenCalledWith('https://files.example.test/song.mp3?sig=old');
    expect(downloadData).toHaveBeenCalledWith(blob, 'song.mp3');
  });

  it('hides the download button when asked', () => {
    renderPlayer(makeFile(), { hideDownload: true });
    expect(screen.queryByTestId('media-player-download-btn')).toBeNull();
  });

  it('keeps clicks on the player from reaching the surrounding row', () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <MediaPlayer file={makeFile()} />
      </div>,
      { wrapper: Wrapper }
    );
    fireEvent.click(screen.getByTestId('media-player-audio'));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
