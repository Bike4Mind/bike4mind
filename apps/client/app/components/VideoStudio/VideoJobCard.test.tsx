import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoGeneration } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  query: {} as { data?: VideoGeneration; isPending: boolean; isError: boolean; refetch: ReturnType<typeof vi.fn> },
  cancel: { mutate: vi.fn(), isPending: false, isSuccess: false },
  setOpen: vi.fn(),
  downloadData: vi.fn(),
  downloadUrl: vi.fn(),
}));

vi.mock('@client/app/hooks/data/videoGenerations', () => ({
  useVideoGeneration: () => h.query,
  useCancelVideoGeneration: () => h.cancel,
}));
vi.mock('@client/app/components/Files/fileBrowserStore', () => ({
  useFileBrowser: (selector: (state: { setOpen: (open: boolean) => void }) => unknown) =>
    selector({ setOpen: h.setOpen }),
}));
vi.mock('@client/app/utils/download', () => ({ downloadData: h.downloadData, downloadUrl: h.downloadUrl }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { readyOutput, videoJob } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import VideoJobCard, { MAX_PLAYER_URL_REFRESHES } from './VideoJobCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const card = () => (
  <CssVarsProvider theme={appTheme}>
    <VideoJobCard jobId="job-1" />
  </CssVarsProvider>
);

const showJob = (job: VideoGeneration) => {
  h.query = { data: job, isPending: false, isError: false, refetch: vi.fn().mockResolvedValue({ data: job }) };
};
const succeeded = (output: VideoGeneration['output']) => videoJob({ state: 'succeeded', progress: 1, output });

beforeEach(() => {
  vi.clearAllMocks();
  h.cancel = { mutate: vi.fn(), isPending: false, isSuccess: false };
});
afterEach(() => vi.unstubAllGlobals());

describe('VideoJobCard states', () => {
  it('keeps rendering the cached job when a refetch failed', () => {
    h.query = { data: videoJob({ state: 'running' }), isPending: false, isError: true, refetch: vi.fn() };
    render(card());
    expect(screen.getByTestId('video-job-card')).toBeInTheDocument();
    expect(screen.queryByTestId('video-job-card-missing')).not.toBeInTheDocument();
  });

  it('shows the missing note only when there is no data', () => {
    h.query = { data: undefined, isPending: false, isError: true, refetch: vi.fn() };
    render(card());
    expect(screen.getByTestId('video-job-card-missing')).toBeInTheDocument();
  });

  it('shows Finishing while a succeeded frame has no output yet', () => {
    showJob(succeeded(null));
    render(card());
    expect(screen.getByTestId('video-job-card-finishing-note')).toHaveTextContent('Finishing...');
    expect(screen.queryByTestId('video-job-card-unavailable-note')).not.toBeInTheDocument();
  });

  it('labels a scanning clip Checking, never Ready', () => {
    showJob(succeeded(readyOutput({ availability: 'pending_scan', url: null, expires_at: null })));
    render(card());
    expect(screen.getByTestId('video-job-card-status')).toHaveTextContent('Checking');
    expect(screen.getByTestId('video-job-card-status')).not.toHaveTextContent('Ready');
    expect(screen.getByTestId('video-job-card-progress')).toBeInTheDocument();
  });

  // Joy sizes the indeterminate sweep from `value`; a finished job's 100 makes it overflow the card.
  it('keeps the default sweep width on an indeterminate bar after progress reached 100%', () => {
    showJob({
      ...succeeded(readyOutput({ availability: 'pending_scan', url: null, expires_at: null })),
      progress: 1,
    });
    render(card());
    const progress = screen.getByTestId('video-job-card-progress');
    expect(progress.style.getPropertyValue('--LinearProgress-percent')).toBe('25');
  });

  it('labels a playable clip Ready', () => {
    showJob(succeeded(readyOutput()));
    render(card());
    expect(screen.getByTestId('video-job-card-status')).toHaveTextContent('Ready');
    expect(screen.queryByTestId('video-job-card-progress')).not.toBeInTheDocument();
  });

  it('shows a queued job with Cancel', () => {
    showJob(videoJob({ state: 'pending' }));
    render(card());
    expect(screen.getByTestId('video-job-card-status')).toHaveTextContent('Queued');
    expect(screen.getByTestId('video-job-card-progress')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('video-job-card-cancel-btn'));
    expect(h.cancel.mutate).toHaveBeenCalledWith('job-1');
  });

  it('shows the progress of a running job', () => {
    showJob(videoJob({ state: 'running', progress: 0.4 }));
    render(card());
    expect(screen.getByTestId('video-job-card-status')).toHaveTextContent('Generating');
    expect(screen.getByTestId('video-job-card-progress-label')).toHaveTextContent('40%');
  });

  it('says Cancelling once a cancel is accepted and the job is still running', () => {
    showJob(videoJob({ state: 'running' }));
    h.cancel = { mutate: vi.fn(), isPending: false, isSuccess: true };
    render(card());
    expect(screen.getByTestId('video-job-card-status')).toHaveTextContent('Cancelling');
    expect(screen.getByTestId('video-job-card-cancel-btn')).toBeDisabled();
  });

  it('offers no Cancel while storing (the clip is already paid for)', () => {
    showJob(videoJob({ state: 'storing' }));
    render(card());
    expect(screen.getByTestId('video-job-card-status')).toHaveTextContent('Saving');
    expect(screen.queryByTestId('video-job-card-cancel-btn')).not.toBeInTheDocument();
  });

  it('plays a ready video inline and offers Download and Open in Files', () => {
    showJob(succeeded(readyOutput()));
    render(card());
    expect(screen.getByTestId('video-job-card-player')).toHaveAttribute('src', readyOutput().url);
    expect(screen.getByTestId('video-job-card-download-btn')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('video-job-card-open-files-btn'));
    expect(h.setOpen).toHaveBeenCalledWith(true);
    expect(screen.queryByTestId('video-job-card-cancel-btn')).not.toBeInTheDocument();
  });

  it('has no Open in Files for a clip stored outside Files', () => {
    showJob(succeeded(readyOutput({ file_id: null })));
    render(card());
    expect(screen.queryByTestId('video-job-card-open-files-btn')).not.toBeInTheDocument();
  });

  it('explains a clip that is still being scanned', () => {
    showJob(succeeded(readyOutput({ availability: 'pending_scan', url: null, expires_at: null })));
    render(card());
    expect(screen.getByTestId('video-job-card-scan-note')).toBeInTheDocument();
    expect(screen.queryByTestId('video-job-card-player')).not.toBeInTheDocument();
    expect(screen.queryByTestId('video-job-card-download-btn')).not.toBeInTheDocument();
  });

  it('explains a clip that is no longer available', () => {
    showJob(succeeded(readyOutput({ availability: 'unavailable', url: null, expires_at: null })));
    render(card());
    expect(screen.getByTestId('video-job-card-unavailable-note')).toBeInTheDocument();
    expect(screen.queryByTestId('video-job-card-open-files-btn')).not.toBeInTheDocument();
  });

  it.each([
    ['failed', 'provider_error', 'The provider failed to generate the video.'],
    ['blocked', 'content_blocked', 'The provider declined to generate this video under its content policy.'],
    ['cancelled', 'cancelled', 'The generation was cancelled.'],
  ] as const)('shows the server message for a %s job', (state, code, message) => {
    showJob(videoJob({ state, error: { code, message } }));
    render(card());
    expect(screen.getByTestId('video-job-card-error')).toHaveTextContent(message);
    expect(screen.queryByTestId('video-job-card-cancel-btn')).not.toBeInTheDocument();
  });

  it('says so when the job cannot be loaded', () => {
    h.query = { data: undefined, isPending: false, isError: true, refetch: vi.fn() };
    render(card());
    expect(screen.getByTestId('video-job-card-missing')).toBeInTheDocument();
  });
});

describe('VideoJobCard playback URL', () => {
  it('keeps the player src across a re-sign and swaps on error', () => {
    showJob(succeeded(readyOutput({ url: 'https://files.example/a' })));
    const { rerender } = render(card());
    showJob(succeeded(readyOutput({ url: 'https://files.example/b' })));
    rerender(card());
    const player = screen.getByTestId('video-job-card-player');
    expect(player).toHaveAttribute('src', 'https://files.example/a');
    fireEvent.error(player);
    expect(screen.getByTestId('video-job-card-player')).toHaveAttribute('src', 'https://files.example/b');
  });

  it('stops refreshing after MAX_PLAYER_URL_REFRESHES failed loads', () => {
    showJob(succeeded(readyOutput()));
    render(card());
    for (let attempt = 0; attempt < MAX_PLAYER_URL_REFRESHES + 3; attempt += 1) {
      fireEvent.error(screen.getByTestId('video-job-card-player'));
    }
    expect(h.query.refetch).toHaveBeenCalledTimes(MAX_PLAYER_URL_REFRESHES);
  });
});

describe('VideoJobCard download', () => {
  it('re-reads the job and saves the fresh URL as a file', async () => {
    showJob(succeeded(readyOutput()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['clip']) }));
    render(card());
    fireEvent.click(screen.getByTestId('video-job-card-download-btn'));
    await waitFor(() => expect(h.downloadData).toHaveBeenCalledWith(expect.any(Blob), 'video-job-1.mp4', 'video/mp4'));
    expect(h.query.refetch).toHaveBeenCalled();
  });

  it('falls back to a plain link when the browser cannot read the file', async () => {
    showJob(succeeded(readyOutput()));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(card());
    fireEvent.click(screen.getByTestId('video-job-card-download-btn'));
    await waitFor(() => expect(h.downloadUrl).toHaveBeenCalledWith(readyOutput().url, 'video-job-1.mp4'));
  });
});
