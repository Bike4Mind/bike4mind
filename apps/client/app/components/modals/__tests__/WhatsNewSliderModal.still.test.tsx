// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IModalDocument, ModalStillImage, ModalVideo, PublicReleaseNote } from '@bike4mind/common';
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

const STILL: ModalStillImage = {
  landscapeUrl: `${S3}/modals/still.png`,
  portraitUrl: `${S3}/modals/still-9x16.png`,
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

const stillEl = () => screen.findByTestId('whats-new-slide-still') as Promise<HTMLImageElement>;

describe('WhatsNewSliderModal still slides', () => {
  beforeEach(() => {
    mocks.isMobile = false;
    mocks.reducedMotion = false;
    mocks.signature = 1;
    mocks.withhold = false;
    mocks.mutateAsync = vi.fn(async ({ filePaths }: { filePaths: string[] }) =>
      filePaths.map(p => (mocks.withhold ? null : sign(p, mocks.signature)))
    );
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the 16:9 still in the video slot on desktop', async () => {
    renderSlider([slide('a', '2026-10-22T00:00:00Z', { stillImage: STILL })]);

    const still = await stillEl();
    expect(still.getAttribute('src')).toBe(sign('modals/still.png'));
    expect(still.getAttribute('alt')).toBe('Slide a');
    expect(screen.getByTestId('whats-new-slide-video-slot')).toBeTruthy();
    expect(screen.queryByTestId('whats-new-slide-video')).toBeNull();
  });

  it('shows the 9:16 still on mobile', async () => {
    mocks.isMobile = true;
    renderSlider([slide('a', '2026-10-22T00:00:00Z', { stillImage: STILL })]);

    expect((await stillEl()).getAttribute('src')).toBe(sign('modals/still-9x16.png'));
  });

  it('falls back to the other still orientation', async () => {
    renderSlider([slide('a', '2026-10-22T00:00:00Z', { stillImage: { portraitUrl: STILL.portraitUrl } })]);

    expect((await stillEl()).getAttribute('src')).toBe(sign('modals/still-9x16.png'));
  });

  it('plays the video and never shows or signs the still when a note has both', async () => {
    renderSlider([slide('a', '2026-10-22T00:00:00Z', { video: VIDEO, stillImage: STILL })]);

    expect(await screen.findByTestId('whats-new-slide-video')).toBeTruthy();
    expect(screen.queryByTestId('whats-new-slide-still')).toBeNull();
    for (const [vars] of vi.mocked(mocks.mutateAsync).mock.calls) {
      expect(vars.filePaths).not.toContain('modals/still.png');
      expect(vars.filePaths).not.toContain('modals/still-9x16.png');
    }
  });

  it('drops the still slot when the still fails to load after one retry', async () => {
    const route = '/api/v1/whats-new/media/a/image-landscape';
    renderSlider([slide('a', '2026-10-22T00:00:00Z', { stillImage: { landscapeUrl: route } })]);
    const still = await stillEl();
    expect(still.getAttribute('src')).toBe(route);

    fireEvent.error(still);
    await waitFor(() =>
      expect(screen.getByTestId('whats-new-slide-still').getAttribute('src')).toBe(`${route}?retry=1`)
    );

    fireEvent.error(screen.getByTestId('whats-new-slide-still'));
    await waitFor(() => expect(screen.queryByTestId('whats-new-slide-video-slot')).toBeNull());
    expect(screen.queryByTestId('whats-new-slide-still')).toBeNull();
    expect(document.getElementById('whats-new-modal-title')?.textContent).toBe('Slide a');
  });

  it('drops the still slot when the server withholds the still url', async () => {
    mocks.withhold = true;
    renderSlider([slide('a', '2026-10-22T00:00:00Z', { stillImage: STILL })]);

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('whats-new-slide-video-slot')).toBeNull());
    expect(screen.queryByTestId('whats-new-slide-still')).toBeNull();
    expect(document.getElementById('whats-new-modal-title')?.textContent).toBe('Slide a');
  });
});
