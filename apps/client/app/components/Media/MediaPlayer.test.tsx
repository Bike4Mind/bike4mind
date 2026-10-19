import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import MediaPlayer, { SCAN_POLL_INTERVAL_MS, SCAN_WAIT_MS, type MediaPlayerFile } from './MediaPlayer';

const { getFabFileByIdFromServer, downloadData, toastError } = vi.hoisted(() => ({
  getFabFileByIdFromServer: vi.fn(),
  downloadData: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@client/app/utils/filesAPICalls', () => ({ getFabFileByIdFromServer }));
vi.mock('@client/app/utils/download', () => ({ downloadData }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const OLD_URL = 'https://files.example.test/song.mp3?sig=old';
const NEW_URL = 'https://files.example.test/song.mp3?sig=new';
const MINUTE_MS = 60 * 1000;

const makeFile = (overrides: Partial<MediaPlayerFile> = {}): MediaPlayerFile => ({
  id: 'file-1',
  fileName: 'song.mp3',
  mimeType: 'audio/mpeg',
  fileUrl: OLD_URL,
  fileUrlExpireAt: new Date(Date.now() + 60 * MINUTE_MS),
  ...overrides,
});

const renderPlayer = (file: MediaPlayerFile, props: { hideDownload?: boolean; preload?: 'none' | 'metadata' } = {}) =>
  render(<MediaPlayer file={file} {...props} />, { wrapper: Wrapper });

const audio = () => screen.getByTestId('media-player-audio');
const srcOf = (element: HTMLElement) => element.getAttribute('src');

describe('MediaPlayer', () => {
  beforeEach(() => {
    getFabFileByIdFromServer.mockReset();
    downloadData.mockReset();
    toastError.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('renders an audio element for an audio file, with metadata preload by default', () => {
      renderPlayer(makeFile());
      expect(audio().tagName).toBe('AUDIO');
      expect(srcOf(audio())).toBe(OLD_URL);
      expect(audio().getAttribute('preload')).toBe('metadata');
      expect(screen.queryByTestId('media-player-video')).toBeNull();
    });

    it('renders a video element for a video file', () => {
      renderPlayer(makeFile({ fileName: 'clip.mp4', mimeType: 'video/mp4' }));
      expect(screen.getByTestId('media-player-video').tagName).toBe('VIDEO');
    });

    it('honours preload none for long lists', () => {
      renderPlayer(makeFile(), { preload: 'none' });
      expect(audio().getAttribute('preload')).toBe('none');
    });

    it('falls back to the presigned URL when there is no file URL', () => {
      renderPlayer(makeFile({ fileUrl: undefined, fileUrlExpireAt: undefined, presignedUrl: 'https://p.test/x' }));
      expect(srcOf(audio())).toBe('https://p.test/x');
      expect(getFabFileByIdFromServer).not.toHaveBeenCalled();
    });

    it('starts over for a different file', async () => {
      getFabFileByIdFromServer.mockRejectedValue(new Error('gone'));
      const { rerender } = renderPlayer(makeFile());
      fireEvent.error(audio());
      expect(await screen.findByTestId('media-player-error')).toBeTruthy();

      rerender(<MediaPlayer file={makeFile({ id: 'file-2', fileUrl: 'https://files.example.test/other.mp3' })} />);
      expect(srcOf(audio())).toBe('https://files.example.test/other.mp3');
    });
  });

  describe('url re-signing', () => {
    it('leaves an unexpired URL alone, even close to expiry: the server would return the same one', () => {
      renderPlayer(makeFile({ fileUrlExpireAt: new Date(Date.now() + MINUTE_MS) }));
      expect(getFabFileByIdFromServer).not.toHaveBeenCalled();
      expect(srcOf(audio())).toBe(OLD_URL);
    });

    it('re-signs an expired URL on mount without handing the expired one to the element', async () => {
      let resolve: (value: { fileUrl: string }) => void = () => {};
      getFabFileByIdFromServer.mockReturnValue(new Promise(r => (resolve = r)));
      renderPlayer(makeFile({ fileUrlExpireAt: new Date(Date.now() - MINUTE_MS) }));

      expect(srcOf(audio())).toBeNull();
      // An error from the element while the re-sign is in flight must not fail the player.
      fireEvent.error(audio());
      expect(screen.queryByTestId('media-player-error')).toBeNull();
      await act(async () => resolve({ fileUrl: NEW_URL }));

      expect(srcOf(audio())).toBe(NEW_URL);
      expect(screen.queryByTestId('media-player-error')).toBeNull();
      expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(1);
      expect(getFabFileByIdFromServer).toHaveBeenCalledWith('file-1');
    });

    it('treats a URL expiring exactly now as expired', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: NEW_URL });
      renderPlayer(makeFile({ fileUrlExpireAt: new Date('2026-01-01T00:00:00Z') }));
      expect(srcOf(audio())).toBeNull();
      await waitFor(() => expect(srcOf(audio())).toBe(NEW_URL));
    });

    it('fetches a URL on mount when the file has none', async () => {
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: NEW_URL });
      renderPlayer(makeFile({ fileUrl: undefined, fileUrlExpireAt: undefined }));
      await waitFor(() => expect(srcOf(audio())).toBe(NEW_URL));
    });

    it('re-signs once when the element fails to load, then plays the new URL', async () => {
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: NEW_URL });
      renderPlayer(makeFile());
      fireEvent.error(audio());
      await waitFor(() => expect(srcOf(audio())).toBe(NEW_URL));
      expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(1);
    });

    it('fails when the re-signed URL fails too, without re-signing again', async () => {
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: NEW_URL });
      renderPlayer(makeFile());
      fireEvent.error(audio());
      await waitFor(() => expect(srcOf(audio())).toBe(NEW_URL));
      fireEvent.error(audio());
      expect(await screen.findByTestId('media-player-error')).toBeTruthy();
      expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(1);
    });

    it('reloads the same URL after a transient error: the server only re-signs an expired URL', async () => {
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: OLD_URL });
      renderPlayer(makeFile());
      const firstElement = audio();
      fireEvent.error(firstElement);
      await waitFor(() => expect(audio()).not.toBe(firstElement));
      expect(srcOf(audio())).toBe(OLD_URL);
      expect(screen.queryByTestId('media-player-error')).toBeNull();
    });

    it('fails when the reloaded same URL fails again: the file itself is unplayable', async () => {
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: OLD_URL });
      renderPlayer(makeFile({ mimeType: 'video/x-matroska', fileName: 'clip.mkv' }));
      const firstElement = screen.getByTestId('media-player-video');
      fireEvent.error(firstElement);
      await waitFor(() => expect(screen.getByTestId('media-player-video')).not.toBe(firstElement));
      fireEvent.error(screen.getByTestId('media-player-video'));
      expect(await screen.findByTestId('media-player-error')).toBeTruthy();
      expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(1);
    });

    it('recovers on retry once a transient error has passed, with the URL unchanged', async () => {
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: OLD_URL });
      renderPlayer(makeFile());
      fireEvent.error(audio());
      await waitFor(() => expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(1));
      fireEvent.error(audio());
      await screen.findByTestId('media-player-error');

      fireEvent.click(screen.getByTestId('media-player-retry-btn'));
      await waitFor(() => expect(srcOf(audio())).toBe(OLD_URL));
      fireEvent.loadedMetadata(audio());
      expect(screen.queryByTestId('media-player-error')).toBeNull();
    });

    it('fails when the server has no URL for the file', async () => {
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: undefined });
      renderPlayer(makeFile());
      fireEvent.error(audio());
      expect(await screen.findByTestId('media-player-error')).toBeTruthy();
    });

    it('re-signs again after a successful load, so a second expiry is recovered too', async () => {
      getFabFileByIdFromServer
        .mockResolvedValueOnce({ fileUrl: 'https://files.example.test/a' })
        .mockResolvedValueOnce({ fileUrl: 'https://files.example.test/b' });
      renderPlayer(makeFile());
      fireEvent.error(audio());
      await waitFor(() => expect(srcOf(audio())).toContain('/a'));
      fireEvent.loadedMetadata(audio());
      fireEvent.error(audio());
      await waitFor(() => expect(srcOf(audio())).toContain('/b'));
      expect(screen.queryByTestId('media-player-error')).toBeNull();
    });

    it('re-signs again when a URL re-signed long ago fails before ever loading (preload none)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      getFabFileByIdFromServer
        .mockResolvedValueOnce({ fileUrl: 'https://files.example.test/a' })
        .mockResolvedValueOnce({ fileUrl: 'https://files.example.test/b' });
      renderPlayer(makeFile({ fileUrlExpireAt: new Date('2025-12-31T00:00:00Z') }), { preload: 'none' });
      await waitFor(() => expect(srcOf(audio())).toContain('/a'));

      vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
      fireEvent.error(audio());

      await waitFor(() => expect(srcOf(audio())).toContain('/b'));
      expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('media-player-error')).toBeNull();
    });

    it('announces the error state and retries on demand', async () => {
      getFabFileByIdFromServer.mockRejectedValueOnce(new Error('gone'));
      renderPlayer(makeFile());
      fireEvent.error(audio());
      expect((await screen.findByTestId('media-player-error')).getAttribute('role')).toBe('alert');

      getFabFileByIdFromServer.mockResolvedValueOnce({ fileUrl: NEW_URL });
      fireEvent.click(screen.getByTestId('media-player-retry-btn'));
      await waitFor(() => expect(srcOf(audio())).toBe(NEW_URL));
    });
  });

  describe('a file still in its moderation scan', () => {
    // A just-saved file (a fresh Studio speech clip) is 'pending' until the S3 upload event scans it, about a
    // second later, and every read withholds its URL until then.
    const pendingFile = () => makeFile({ fileUrl: undefined, fileUrlExpireAt: undefined, moderationStatus: 'pending' });

    it('waits for the scan to clear, then plays the signed URL', async () => {
      vi.useFakeTimers();
      getFabFileByIdFromServer
        .mockResolvedValueOnce({ fileUrl: undefined, moderationStatus: 'pending' })
        .mockResolvedValueOnce({ fileUrl: undefined, moderationStatus: 'scanning' })
        .mockResolvedValueOnce({ fileUrl: NEW_URL, moderationStatus: 'clean' });
      renderPlayer(pendingFile());

      await act(() => vi.advanceTimersByTimeAsync(2 * SCAN_POLL_INTERVAL_MS));

      expect(srcOf(audio())).toBe(NEW_URL);
      expect(screen.queryByTestId('media-player-error')).toBeNull();
      expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(3);
    });

    it('gives up once the scan has not cleared within the wait window', async () => {
      vi.useFakeTimers();
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: undefined, moderationStatus: 'pending' });
      renderPlayer(pendingFile());

      await act(() => vi.advanceTimersByTimeAsync(SCAN_WAIT_MS - SCAN_POLL_INTERVAL_MS));
      expect(screen.queryByTestId('media-player-error')).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(2 * SCAN_POLL_INTERVAL_MS));

      expect(screen.getByTestId('media-player-error')).toBeTruthy();
      const calls = getFabFileByIdFromServer.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(10 * SCAN_POLL_INTERVAL_MS));
      expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(calls);
    });

    it('fails at once, without polling, for a file the scan blocked', async () => {
      vi.useFakeTimers();
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: undefined, moderationStatus: 'blocked' });
      renderPlayer(pendingFile());

      await act(() => vi.advanceTimersByTimeAsync(5 * SCAN_POLL_INTERVAL_MS));

      expect(screen.getByTestId('media-player-error')).toBeTruthy();
      expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(1);
    });

    it('stops polling once unmounted', async () => {
      vi.useFakeTimers();
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: undefined, moderationStatus: 'pending' });
      const { unmount } = renderPlayer(pendingFile());
      await act(() => vi.advanceTimersByTimeAsync(SCAN_POLL_INTERVAL_MS));
      const calls = getFabFileByIdFromServer.mock.calls.length;

      unmount();
      await vi.advanceTimersByTimeAsync(10 * SCAN_POLL_INTERVAL_MS);

      expect(getFabFileByIdFromServer).toHaveBeenCalledTimes(calls);
    });
  });

  describe('download', () => {
    it('downloads the current file as a blob under its file name', async () => {
      const blob = new Blob(['mp3']);
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
      vi.stubGlobal('fetch', fetchMock);
      renderPlayer(makeFile());
      await act(async () => {
        fireEvent.click(screen.getByTestId('media-player-download-btn'));
      });
      // Bypasses the cache: the element's own no-Origin reply for this URL has no CORS headers.
      expect(fetchMock).toHaveBeenCalledWith(OLD_URL, { cache: 'no-store' });
      expect(downloadData).toHaveBeenCalledWith(blob, 'song.mp3');
    });

    it('re-signs and retries once when the URL expired while the player was open', async () => {
      const blob = new Blob(['mp3']);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 403 })
        .mockResolvedValueOnce({ ok: true, blob: async () => blob });
      vi.stubGlobal('fetch', fetchMock);
      getFabFileByIdFromServer.mockResolvedValue({ fileUrl: NEW_URL });
      renderPlayer(makeFile());
      await act(async () => {
        fireEvent.click(screen.getByTestId('media-player-download-btn'));
      });
      expect(fetchMock).toHaveBeenLastCalledWith(NEW_URL, { cache: 'no-store' });
      expect(downloadData).toHaveBeenCalledWith(blob, 'song.mp3');
      // The playing element keeps its URL, so a download does not restart playback.
      expect(srcOf(audio())).toBe(OLD_URL);
    });

    it.each([
      [
        'the re-signed URL fails too',
        () => {
          vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
          getFabFileByIdFromServer.mockResolvedValue({ fileUrl: NEW_URL });
        },
      ],
      [
        'the re-sign returns the same URL',
        () => {
          vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
          getFabFileByIdFromServer.mockResolvedValue({ fileUrl: OLD_URL });
        },
      ],
      [
        'the re-sign throws',
        () => {
          vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
          getFabFileByIdFromServer.mockRejectedValue(new Error('gone'));
        },
      ],
      ['fetch rejects', () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')))],
    ])('shows a toast and saves nothing when %s', async (_case, arrange) => {
      arrange();
      renderPlayer(makeFile());
      await act(async () => {
        fireEvent.click(screen.getByTestId('media-player-download-btn'));
      });
      expect(toastError).toHaveBeenCalledWith('media_player.download_failed');
      expect(downloadData).not.toHaveBeenCalled();
    });

    it('hides the download button when asked', () => {
      renderPlayer(makeFile(), { hideDownload: true });
      expect(screen.queryByTestId('media-player-download-btn')).toBeNull();
    });
  });

  it('keeps clicks on the player from reaching the surrounding row', () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <MediaPlayer file={makeFile()} />
      </div>,
      { wrapper: Wrapper }
    );
    fireEvent.click(audio());
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
