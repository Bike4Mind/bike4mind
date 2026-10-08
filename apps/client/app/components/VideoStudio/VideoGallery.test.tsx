import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ query: {} as Record<string, unknown>, fetchNextPage: vi.fn() }));

vi.mock('@client/app/hooks/data/videoGenerations', () => ({ useVideoGenerations: () => h.query }));
vi.mock('./VideoJobCard', () => ({
  default: ({ jobId }: { jobId: string }) => <div data-testid="gallery-card">{jobId}</div>,
}));

import { listOf, videoJob } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import VideoGallery from './VideoGallery';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderGallery = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <VideoGallery />
    </CssVarsProvider>
  );
const loaded = (data: ReturnType<typeof listOf>, hasNextPage = false) => {
  h.query = {
    data,
    isPending: false,
    isError: false,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: h.fetchNextPage,
  };
};

beforeEach(() => vi.clearAllMocks());

describe('VideoGallery', () => {
  it('renders one card per job in server order (newest first), across pages', () => {
    loaded(listOf([videoJob({ id: 'c' }), videoJob({ id: 'b' })], [videoJob({ id: 'a' })]));
    renderGallery();
    expect(screen.getAllByTestId('gallery-card').map(node => node.textContent)).toEqual(['c', 'b', 'a']);
  });

  it('renders a job once when a prepend pushed it onto the next page too', () => {
    loaded(listOf([videoJob({ id: 'new' }), videoJob({ id: 'b' })], [videoJob({ id: 'b' }), videoJob({ id: 'a' })]));
    renderGallery();
    expect(screen.getAllByTestId('gallery-card').map(node => node.textContent)).toEqual(['new', 'b', 'a']);
  });

  it('loads more while there is a next page', () => {
    loaded(listOf([videoJob()]), true);
    renderGallery();
    fireEvent.click(screen.getByTestId('video-gallery-load-more-btn'));
    expect(h.fetchNextPage).toHaveBeenCalled();
  });

  it('hides Load more on the last page', () => {
    loaded(listOf([videoJob()]));
    renderGallery();
    expect(screen.queryByTestId('video-gallery-load-more-btn')).not.toBeInTheDocument();
  });

  it('shows an empty state', () => {
    loaded(listOf([]));
    renderGallery();
    expect(screen.getByTestId('video-gallery-empty')).toBeInTheDocument();
  });

  it('shows an error state', () => {
    h.query = { data: undefined, isPending: false, isError: true };
    renderGallery();
    expect(screen.getByTestId('video-gallery-error')).toBeInTheDocument();
  });

  it('keeps rendering cards when a background refetch failed', () => {
    loaded(listOf([videoJob({ id: 'a' })]));
    h.query = { ...h.query, isError: true };
    renderGallery();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(1);
    expect(screen.queryByTestId('video-gallery-error')).not.toBeInTheDocument();
  });

  it('keeps the cards and shows an inline error when loading the next page failed', () => {
    loaded(listOf([videoJob({ id: 'a' })]), true);
    h.query = { ...h.query, isError: true, isFetchNextPageError: true };
    renderGallery();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(1);
    expect(screen.getByTestId('video-gallery-load-more-error')).toBeInTheDocument();
    expect(screen.getByTestId('video-gallery-load-more-btn')).toBeInTheDocument();
  });
});
