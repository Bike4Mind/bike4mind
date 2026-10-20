// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IModalDocument, ModalVideo, PublicReleaseNote } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { releaseNoteToModal } from '../releaseNoteSlides';
import WhatsNewSliderModal from '../WhatsNewSliderModal';

const sign = (path: string, n = 1) => `https://signed.test/${path}?sig=${n}`;

const mocks = vi.hoisted(() => ({
  user: { id: 'u1', tags: [] },
  counters: { isPending: false, data: [] as unknown[] },
  modals: { data: undefined as unknown, isPending: false, slidesPending: false, refetch: () => {} },
  isMobile: false,
  reducedMotion: false,
  signature: 1,
  withhold: false,
  mutateAsync: null as unknown as (vars: { filePaths: string[] }) => Promise<(string | null)[]>,
}));

vi.mock('@mui/system', async importOriginal => ({
  ...(await importOriginal<typeof import('@mui/system')>()),
  useMediaQuery: (query: string) => (query.includes('reduced-motion') ? mocks.reducedMotion : mocks.isMobile),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: mocks.user }),
}));
vi.mock('@client/app/hooks/data/modalsWithReleaseNotes', () => ({
  useModalsWithReleaseNotes: () => mocks.modals,
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetUserActivityCounters: () => mocks.counters,
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), getQueryData: () => [], setQueryData: vi.fn() }),
}));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: vi.fn() }) }));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetPresignedUrl: () => ({
    mutate: (vars: { filePaths: string[] }, opts?: { onSuccess?: (urls: string[]) => void }) =>
      opts?.onSuccess?.(vars.filePaths.map(p => `https://signed.test/${p}?sig=1`)),
    mutateAsync: mocks.mutateAsync,
    isPending: false,
  }),
}));
vi.mock('@client/app/contexts/ModalTriggerContext', () => ({
  useModalTrigger: () => ({ resetTrigger: vi.fn() }),
}));
vi.mock('@client/app/components/Knowledge/MarkdownViewer', () => ({
  default: () => <div />,
}));

const S3 = 'https://bucket.s3.us-east-2.amazonaws.com';
const VIDEO: ModalVideo = {
  landscapeUrl: `${S3}/modals/wide.mp4`,
  landscapePosterUrl: `${S3}/modals/wide.png`,
  portraitUrl: `${S3}/modals/tall.mp4`,
  portraitPosterUrl: `${S3}/modals/tall.png`,
};

const slide = (id: string, published: string, extra: Partial<IModalDocument>): IModalDocument => ({
  ...releaseNoteToModal({
    id,
    release_tag: `v-${id}`,
    headline: `Slide ${id}`,
    summary: 'Summary',
    published_at: published,
    items: [],
  } as PublicReleaseNote),
  ...extra,
});

const appTheme = extendTheme({ ...getThemeConfig() });
const renderSlider = (slides: IModalDocument[]) => {
  mocks.modals = { data: slides, isPending: false, slidesPending: false, refetch: () => {} };
  return render(
    <CssVarsProvider theme={appTheme}>
      <WhatsNewSliderModal tagToTrigger="whats-new" />
    </CssVarsProvider>
  );
};

const videoEl = () => screen.findByTestId('whats-new-slide-video') as Promise<HTMLVideoElement>;

describe('WhatsNewSliderModal video slides', () => {
  let play: ReturnType<typeof vi.spyOn>;
  let pause: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.isMobile = false;
    mocks.reducedMotion = false;
    mocks.signature = 1;
    mocks.withhold = false;
    mocks.mutateAsync = vi.fn(async ({ filePaths }: { filePaths: string[] }) =>
      filePaths.map(p => (mocks.withhold ? null : sign(p, mocks.signature)))
    );
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('plays the landscape cut with its poster on desktop, in place of the image', async () => {
    renderSlider([slide('a', '2026-03-05T00:00:00Z', { video: VIDEO, imageUrl: `${S3}/modals/shot.png` })]);

    const video = await videoEl();
    expect(video.getAttribute('src')).toBe(sign('modals/wide.mp4'));
    expect(video.getAttribute('poster')).toBe(sign('modals/wide.png'));
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(screen.queryByRole('img', { name: 'Slide a' })).toBeNull();
    await waitFor(() => expect(play).toHaveBeenCalled());
  });

  it('plays the portrait cut on mobile', async () => {
    mocks.isMobile = true;
    renderSlider([slide('a', '2026-03-05T00:00:00Z', { video: VIDEO })]);

    const video = await videoEl();
    expect(video.getAttribute('src')).toBe(sign('modals/tall.mp4'));
    expect(video.getAttribute('poster')).toBe(sign('modals/tall.png'));
  });

  it('falls back to the other orientation when one is missing', async () => {
    renderSlider([slide('a', '2026-03-05T00:00:00Z', { video: { ...VIDEO, landscapeUrl: null } })]);
    expect((await videoEl()).getAttribute('src')).toBe(sign('modals/tall.mp4'));
  });

  it('does not autoplay when the user prefers reduced motion', async () => {
    mocks.reducedMotion = true;
    renderSlider([slide('a', '2026-03-05T00:00:00Z', { video: VIDEO })]);

    await videoEl();
    // Let the mount effects and any pending re-renders settle before asserting the negative
    await waitFor(() => expect(pause).toHaveBeenCalled());
    expect(play).not.toHaveBeenCalled();
  });

  it('pauses the video when the slide changes', async () => {
    renderSlider([
      slide('a', '2026-03-05T00:00:00Z', { video: VIDEO }),
      slide('b', '2026-03-01T00:00:00Z', { imageUrl: `${S3}/modals/shot.png` }),
    ]);
    await videoEl();
    pause.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Next announcement' }));

    expect(pause).toHaveBeenCalled();
    expect(screen.queryByTestId('whats-new-slide-video')).toBeNull();
  });

  it('keeps the image path unchanged for a slide without video', async () => {
    renderSlider([slide('b', '2026-03-01T00:00:00Z', { imageUrl: `${S3}/modals/shot.png` })]);

    const img = await screen.findByRole('img', { name: 'Slide b' });
    expect(img.getAttribute('src')).toBe(sign('modals/shot.png'));
    expect(screen.queryByTestId('whats-new-slide-video')).toBeNull();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows the image when the server withholds the video url', async () => {
    mocks.withhold = true;
    renderSlider([slide('a', '2026-03-05T00:00:00Z', { video: VIDEO, imageUrl: `${S3}/modals/shot.png` })]);

    expect(await screen.findByRole('img', { name: 'Slide a' })).toBeTruthy();
    expect(screen.queryByTestId('whats-new-slide-video')).toBeNull();
  });

  it('pauses the video when the slider closes', async () => {
    renderSlider([slide('a', '2026-03-05T00:00:00Z', { video: VIDEO })]);
    await videoEl();
    pause.mockClear();

    fireEvent.click(screen.getByTestId('whats-new-slider-modal-close-btn-icon-container'));

    await waitFor(() => expect(pause).toHaveBeenCalled());
  });

  it('shows the image when an unsigned (CDN) video fails to play', async () => {
    renderSlider([
      slide('a', '2026-03-05T00:00:00Z', {
        video: { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4' },
        imageUrl: `${S3}/modals/shot.png`,
      }),
    ]);
    const video = await videoEl();
    expect(video.getAttribute('src')).toBe('https://d111.cloudfront.net/wide.mp4');

    fireEvent.error(video);

    expect(await screen.findByRole('img', { name: 'Slide a' })).toBeTruthy();
    expect(screen.queryByTestId('whats-new-slide-video')).toBeNull();
    expect(mocks.mutateAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePaths: expect.arrayContaining([expect.stringContaining('wide.mp4')]) })
    );
  });

  it('shows the poster when a video without a slide image fails to play', async () => {
    renderSlider([
      slide('a', '2026-03-05T00:00:00Z', {
        video: { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4', landscapePosterUrl: `${S3}/modals/wide.png` },
      }),
    ]);
    fireEvent.error(await videoEl());

    const poster = await screen.findByTestId('whats-new-slide-video-poster');
    expect(poster.getAttribute('src')).toBe(sign('modals/wide.png'));
  });

  it('re-signs at most once per 30s, then falls back to the image', async () => {
    renderSlider([slide('a', '2026-03-05T00:00:00Z', { video: VIDEO, imageUrl: `${S3}/modals/shot.png` })]);
    const video = await videoEl();
    const callsBefore = vi.mocked(mocks.mutateAsync).mock.calls.length;

    mocks.signature = 2;
    fireEvent.error(video);
    await waitFor(() => expect(video.getAttribute('src')).toBe(sign('modals/wide.mp4', 2)));
    fireEvent.error(video);

    expect(await screen.findByRole('img', { name: 'Slide a' })).toBeTruthy();
    expect(screen.queryByTestId('whats-new-slide-video')).toBeNull();
    expect(vi.mocked(mocks.mutateAsync).mock.calls.length).toBe(callsBefore + 1);
  });

  it('re-signs the video url when playback fails, e.g. on an expired signature', async () => {
    renderSlider([slide('a', '2026-03-05T00:00:00Z', { video: VIDEO })]);
    const video = await videoEl();

    mocks.signature = 2;
    fireEvent.error(video);

    await waitFor(() => expect(video.getAttribute('src')).toBe(sign('modals/wide.mp4', 2)));
    expect(mocks.mutateAsync).toHaveBeenLastCalledWith({ filePaths: ['modals/wide.mp4'], expiresIn: 3600 });
  });
});
