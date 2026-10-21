import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ query: {} as Record<string, unknown> }));

vi.mock('@client/app/hooks/data/musicGenerations', () => ({ useMusicGenerations: () => h.query }));
vi.mock('@client/app/components/Session/MusicJobCard', () => ({
  default: ({ jobId }: { jobId: string }) => <div data-testid="gallery-card">{jobId}</div>,
}));

import { musicJob } from '@client/app/hooks/data/__test__/musicGenerationFixtures';
import MusicGallery from './MusicGallery';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderGallery = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <MusicGallery />
    </CssVarsProvider>
  );
const loaded = (jobs: ReturnType<typeof musicJob>[]) => {
  h.query = {
    data: { pages: [{ data: jobs, next_cursor: null }], pageParams: [undefined] },
    isPending: false,
    isFetchNextPageError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
};

describe('MusicGallery', () => {
  it('renders a music card per song, newest first', () => {
    loaded([musicJob({ id: 'b' }), musicJob({ id: 'a' })]);
    renderGallery();
    expect(screen.getByTestId('music-gallery')).toBeInTheDocument();
    expect(screen.getAllByTestId('gallery-card').map(node => node.textContent)).toEqual(['b', 'a']);
  });

  it('speaks of songs in its empty and error states', () => {
    loaded([]);
    const { unmount } = renderGallery();
    expect(screen.getByTestId('music-gallery-empty')).toHaveTextContent('Songs you generate will appear here.');
    unmount();
    h.query = { data: undefined, isPending: false };
    renderGallery();
    expect(screen.getByTestId('music-gallery-error')).toHaveTextContent('Could not load your songs.');
  });
});
