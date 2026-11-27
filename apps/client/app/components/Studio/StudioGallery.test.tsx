import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import StudioGallery from './StudioGallery';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

type Item = { id: string };

const query = (overrides: Partial<Parameters<typeof StudioGallery<Item>>[0]['query']> = {}) => ({
  data: { pages: [{ data: [] as Item[] }] },
  isPending: false,
  isFetchNextPageError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
  ...overrides,
});

const renderGallery = (variant: 'cards' | 'takes', galleryQuery: ReturnType<typeof query>) =>
  render(
    <StudioGallery<Item>
      testId="gallery"
      noun="images"
      query={galleryQuery}
      variant={variant}
      renderCard={item => <div data-testid={`card-${item.id}`} />}
    />,
    { wrapper: TestWrapper }
  );

describe('StudioGallery takes variant', () => {
  it('shows placeholder tiles while the first page loads', () => {
    renderGallery('takes', query({ data: undefined, isPending: true }));
    const loading = screen.getByTestId('gallery-loading');
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveAccessibleName('Loading your images');
    expect(loading.children).toHaveLength(4);
  });

  it('shows the failed-to-load state as an alert', () => {
    renderGallery('takes', query({ data: undefined }));
    const error = screen.getByTestId('gallery-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('Could not load your images. Refresh to try again.');
  });

  it('shows the empty state as a panel', () => {
    renderGallery('takes', query());
    expect(screen.getByTestId('gallery-empty')).toHaveTextContent('Images you generate will appear here.');
  });

  it('renders every take and the load-more states', () => {
    renderGallery(
      'takes',
      query({ data: { pages: [{ data: [{ id: 'a' }, { id: 'b' }] }] }, isFetchNextPageError: true, hasNextPage: true })
    );
    expect(screen.getByTestId('card-a')).toBeInTheDocument();
    expect(screen.getByTestId('card-b')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-load-more-error')).toHaveTextContent('Could not load more images. Try again.');
    expect(screen.getByTestId('gallery-load-more-btn')).toBeInTheDocument();
  });
});

describe('StudioGallery cards variant', () => {
  it('keeps the stock loading spinner and plain empty text', () => {
    const { unmount } = renderGallery('cards', query({ data: undefined, isPending: true }));
    expect(screen.getByTestId('gallery-loading')).not.toHaveAttribute('role', 'status');
    unmount();
    renderGallery('cards', query());
    expect(screen.getByTestId('gallery-empty').tagName).toBe('P');
  });
});
