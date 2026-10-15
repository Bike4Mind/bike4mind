// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicGeneration } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  query: {} as { data?: MusicGeneration; isPending: boolean; refetch: ReturnType<typeof vi.fn> },
  cancel: { mutate: vi.fn(), isPending: false, isSuccess: false },
  setOpen: vi.fn(),
}));

vi.mock('@client/app/hooks/data/musicGenerations', () => ({
  useMusicGeneration: () => h.query,
  useCancelMusicGeneration: () => h.cancel,
}));
vi.mock('@client/app/components/Media/MediaPlayer', () => ({
  MediaPlayer: ({ file }: { file: { id: string; mimeType: string; fileUrl?: string; fileUrlExpireAt?: Date } }) => (
    <div
      data-testid="media-player-stub"
      data-file-id={file.id}
      data-mime-type={file.mimeType}
      data-src={file.fileUrl}
      data-expires-at={file.fileUrlExpireAt?.toISOString()}
    />
  ),
}));
vi.mock('@client/app/components/Files/fileBrowserStore', () => ({
  useFileBrowser: (selector: (state: { setOpen: (open: boolean) => void }) => unknown) =>
    selector({ setOpen: h.setOpen }),
}));

import { musicJob, musicOutput } from '@client/app/hooks/data/__test__/musicGenerationFixtures';
import MusicJobCard from './MusicJobCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const card = () => (
  <CssVarsProvider theme={appTheme}>
    <MusicJobCard jobId="music-1" />
  </CssVarsProvider>
);
const showJob = (job: MusicGeneration) => {
  h.query = { data: job, isPending: false, refetch: vi.fn().mockResolvedValue({ data: job }) };
};
const succeeded = (output: MusicGeneration['output'], overrides: Partial<MusicGeneration> = {}) =>
  musicJob({ state: 'succeeded', output, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  h.cancel = { mutate: vi.fn(), isPending: false, isSuccess: false };
});

describe('MusicJobCard states', () => {
  it('shows the loading card while the first read is pending', () => {
    h.query = { data: undefined, isPending: true, refetch: vi.fn() };
    render(card());
    expect(screen.getByTestId('music-job-card-loading')).toBeInTheDocument();
  });

  it('shows the missing note when there is no data', () => {
    h.query = { data: undefined, isPending: false, refetch: vi.fn() };
    render(card());
    expect(screen.getByTestId('music-job-card-missing')).toBeInTheDocument();
  });

  it.each([
    ['pending', 'Queued'],
    ['running', 'Composing'],
    ['storing', 'Saving'],
    ['failed', 'Failed'],
    ['blocked', 'Blocked'],
    ['cancelled', 'Cancelled'],
  ] as const)('labels a %s job %s', (state, label) => {
    showJob(musicJob({ state }));
    render(card());
    expect(screen.getByTestId('music-job-card')).toHaveAttribute('data-job-id', 'music-1');
    expect(screen.getByTestId('music-job-card-status')).toHaveTextContent(label);
  });

  it('shows duration, the instrumental flag and the credit hold, with a prompt', () => {
    showJob(musicJob({ instrumental: true, duration_seconds: 45 }));
    render(card());
    expect(screen.getByTestId('music-job-card-meta')).toHaveTextContent('45s, Instrumental, up to 10 credits');
    expect(screen.getByTestId('music-job-card-prompt')).toHaveTextContent('a calm piano piece');
  });

  it('shows the duration the song really has when it differs from the requested one', () => {
    showJob(succeeded(musicOutput({ duration_seconds: 28 }), { duration_seconds: 30 }));
    render(card());
    expect(screen.getByTestId('music-job-card-meta')).toHaveTextContent('28s');
    expect(screen.getByTestId('music-job-card-meta')).not.toHaveTextContent('30s');
  });

  it('shows the settled cost once the song is billed', () => {
    showJob(succeeded(musicOutput(), { credits: { reserved: 10, settled: 7 } }));
    render(card());
    expect(screen.getByTestId('music-job-card-meta')).toHaveTextContent('30s, 7 credits');
  });

  it('leaves the cost out when nothing was held', () => {
    showJob(musicJob({ state: 'failed', credits: { reserved: null, settled: null } }));
    render(card());
    expect(screen.getByTestId('music-job-card-meta')).toHaveTextContent(/^30s$/);
  });

  it('shows Finishing while a succeeded frame has no output yet', () => {
    showJob(succeeded(null));
    render(card());
    expect(screen.getByTestId('music-job-card-status')).toHaveTextContent('Finishing');
    expect(screen.getByTestId('music-job-card-finishing-note')).toBeInTheDocument();
    expect(screen.queryByTestId('music-job-card-player')).not.toBeInTheDocument();
  });

  it('labels a scanning song Checking and shows the scan note', () => {
    showJob(succeeded(musicOutput({ availability: 'pending_scan', url: null, expires_at: null })));
    render(card());
    expect(screen.getByTestId('music-job-card-status')).toHaveTextContent('Checking');
    expect(screen.getByTestId('music-job-card-scan-note')).toBeInTheDocument();
    expect(screen.queryByTestId('music-job-card-player')).not.toBeInTheDocument();
  });

  it('shows the unavailable note and hides Open in Files', () => {
    showJob(succeeded(musicOutput({ availability: 'unavailable', url: null, expires_at: null })));
    render(card());
    expect(screen.getByTestId('music-job-card-unavailable-note')).toBeInTheDocument();
    expect(screen.queryByTestId('music-job-card-open-files-btn')).not.toBeInTheDocument();
  });

  it('shows the public error message of a failed job', () => {
    showJob(musicJob({ state: 'failed', error: { code: 'provider_error', message: 'The provider failed.' } }));
    render(card());
    expect(screen.getByTestId('music-job-card-error')).toHaveTextContent('The provider failed.');
  });
});

describe('MusicJobCard player', () => {
  it('plays a song saved to Files through the shared media player, from the file', () => {
    showJob(succeeded(musicOutput()));
    render(card());
    const player = screen.getByTestId('media-player-stub');
    expect(player).toHaveAttribute('data-file-id', 'file-1');
    expect(player).toHaveAttribute('data-mime-type', 'audio/mpeg');
    expect(player).toHaveAttribute('data-src', 'https://files.example/song-1.mp3?sig=a');
    expect(player).toHaveAttribute('data-expires-at', '2026-10-07T00:15:00.000Z');
    expect(screen.getByTestId('music-job-card-player')).toContainElement(player);
  });

  it('plays a song that could not be saved to Files through a native audio element', () => {
    showJob(succeeded(musicOutput({ file_id: null })));
    render(card());
    const player = screen.getByTestId('music-job-card-player');
    expect(player.tagName).toBe('AUDIO');
    expect(player).toHaveAttribute('src', 'https://files.example/song-1.mp3?sig=a');
    expect(player).toHaveAttribute('controls');
    expect(screen.getByTestId('music-job-card-status')).toHaveTextContent('Ready');
  });

  it('refetches the job when the audio fails to load', () => {
    showJob(succeeded(musicOutput({ file_id: null })));
    render(card());
    expect(h.query.refetch).not.toHaveBeenCalled();
    fireEvent.error(screen.getByTestId('music-job-card-player'));
    expect(h.query.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the first src when the job re-signs mid-play', () => {
    showJob(succeeded(musicOutput({ file_id: null })));
    const { rerender } = render(card());
    showJob(succeeded(musicOutput({ file_id: null, url: 'https://files.example/song-1.mp3?sig=b' })));
    rerender(card());
    expect(screen.getByTestId('music-job-card-player')).toHaveAttribute(
      'src',
      'https://files.example/song-1.mp3?sig=a'
    );
  });
});

describe('MusicJobCard lyrics', () => {
  it('has no lyrics block for an instrumental song', () => {
    showJob(succeeded(musicOutput(), { instrumental: true, lyrics: null }));
    render(card());
    expect(screen.queryByTestId('music-job-card-lyrics-toggle')).not.toBeInTheDocument();
  });

  it('has no lyrics block when the job has no lyrics', () => {
    showJob(succeeded(musicOutput()));
    render(card());
    expect(screen.queryByTestId('music-job-card-lyrics-toggle')).not.toBeInTheDocument();
  });

  it('expands the requested lyrics when the output reports none', () => {
    showJob(succeeded(musicOutput(), { lyrics: 'requested line' }));
    render(card());
    expect(screen.queryByTestId('music-job-card-lyrics')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('music-job-card-lyrics-toggle'));
    expect(screen.getByTestId('music-job-card-lyrics')).toHaveTextContent('requested line');
  });

  it('prefers the lyrics the model sang', () => {
    showJob(succeeded(musicOutput({ lyrics: 'sung line' }), { lyrics: 'requested line' }));
    render(card());
    fireEvent.click(screen.getByTestId('music-job-card-lyrics-toggle'));
    expect(screen.getByTestId('music-job-card-lyrics')).toHaveTextContent('sung line');
  });
});

describe('MusicJobCard actions', () => {
  it.each(['pending', 'running'] as const)('offers Cancel while %s and cancels the job', state => {
    showJob(musicJob({ state }));
    render(card());
    fireEvent.click(screen.getByTestId('music-job-card-cancel-btn'));
    expect(h.cancel.mutate).toHaveBeenCalledWith('music-1');
  });

  it.each(['storing', 'succeeded', 'failed', 'cancelled'] as const)('hides Cancel while %s', state => {
    showJob(musicJob({ state }));
    render(card());
    expect(screen.queryByTestId('music-job-card-cancel-btn')).not.toBeInTheDocument();
  });

  it('shows Cancelling once the cancel was accepted but the job is still live', () => {
    h.cancel = { mutate: vi.fn(), isPending: false, isSuccess: true };
    showJob(musicJob({ state: 'running' }));
    render(card());
    expect(screen.getByTestId('music-job-card-status')).toHaveTextContent('Cancelling');
  });

  it('disables Cancel once the cancel was accepted', () => {
    h.cancel = { mutate: vi.fn(), isPending: false, isSuccess: true };
    showJob(musicJob({ state: 'running' }));
    render(card());
    expect(screen.getByTestId('music-job-card-cancel-btn')).toBeDisabled();
  });

  it('opens the file browser from Open in Files', () => {
    showJob(succeeded(musicOutput()));
    render(card());
    fireEvent.click(screen.getByTestId('music-job-card-open-files-btn'));
    expect(h.setOpen).toHaveBeenCalledWith(true);
  });

  it('hides Open in Files when the song is not in Files', () => {
    showJob(succeeded(musicOutput({ file_id: null })));
    render(card());
    expect(screen.queryByTestId('music-job-card-open-files-btn')).not.toBeInTheDocument();
  });
});
