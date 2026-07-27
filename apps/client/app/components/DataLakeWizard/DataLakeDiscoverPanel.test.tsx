import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { BrowsePublicDataLakesResult } from '@bike4mind/common';
import DataLakeDiscoverPanel from './DataLakeDiscoverPanel';

// The browse hook is the unit under test's only data dependency - drive it directly.
const useBrowsePublicDataLakes = vi.fn();
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useBrowsePublicDataLakes: (...args: unknown[]) => useBrowsePublicDataLakes(...args),
}));

// Collapse the debounce so a keystroke reaches the hook synchronously (no fake timers).
vi.mock('@client/app/hooks/useDebouncedValue', async () => {
  const { useState } = await vi.importActual<typeof import('react')>('react');
  return {
    useDebounceValue: (initial: string) => {
      const [value, setValue] = useState(initial);
      return { value, debouncedValue: value, setValue };
    },
  };
});

// The read-only viewer pulls a heavy import chain (file hooks, markdown, etc.) irrelevant here.
vi.mock('./DataLakeViewer', () => ({
  default: ({ dataLakeName }: { dataLakeName: string }) => <div data-testid="mock-viewer">{dataLakeName}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const fetchNextPage = vi.fn();

const page = (overrides: Partial<BrowsePublicDataLakesResult> = {}): BrowsePublicDataLakesResult => ({
  data: [
    {
      id: 'lk1',
      slug: 'sales',
      name: 'Sales Intelligence',
      description: 'Quarterly decks and notes',
      fileTagPrefix: 'sales:',
      ownerDisplayName: 'Ada Owner',
      fileCount: 12,
      totalSizeBytes: 1024,
      isOwn: false,
      canManage: false,
    },
  ],
  total: 1,
  ...overrides,
});

// Mirror the useInfiniteQuery result shape the panel consumes (pages[] + paging helpers).
const mockState = (
  value: Partial<{
    pages: BrowsePublicDataLakesResult[];
    isLoading: boolean;
    isFetchingNextPage: boolean;
    isError: boolean;
    hasNextPage: boolean;
  }> = {}
) => {
  const { pages, ...rest } = value;
  return {
    data: pages === undefined ? { pages: [page()] } : { pages },
    isLoading: false,
    isFetchingNextPage: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage,
    ...rest,
  };
};

const mockHook = (value: Parameters<typeof mockState>[0] = {}) =>
  useBrowsePublicDataLakes.mockReturnValue(mockState(value));

describe('DataLakeDiscoverPanel', () => {
  beforeEach(() => {
    useBrowsePublicDataLakes.mockReset();
    fetchNextPage.mockReset();
  });

  it('renders a public-lake card with owner, file count, and size', () => {
    mockHook();
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    expect(screen.getByTestId('datalake-discover-card-lk1')).toBeInTheDocument();
    expect(screen.getByText('Sales Intelligence')).toBeInTheDocument();
    expect(screen.getByText('Quarterly decks and notes')).toBeInTheDocument();
    expect(screen.getByText('Ada Owner')).toBeInTheDocument();
    expect(screen.getByText(/12 files/)).toBeInTheDocument();
    expect(screen.getByText(/1.0 KB/)).toBeInTheDocument();
    expect(screen.getByTestId('datalake-discover-count')).toHaveTextContent('Showing 1 of 1');
  });

  it('accumulates lakes across pages and reads total from the first page', () => {
    mockHook({
      pages: [
        page({ total: 30 }),
        { data: [{ ...page().data[0], id: 'lk2', slug: 'ops', name: 'Ops Lake' }], total: 30 },
      ],
    });
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    expect(screen.getByTestId('datalake-discover-card-lk1')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-discover-card-lk2')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-discover-count')).toHaveTextContent('Showing 2 of 30');
  });

  it('shows an "Owned by you" chip and hides the owner chip for the caller’s own lake', () => {
    mockHook({ pages: [page({ data: [{ ...page().data[0], isOwn: true, ownerDisplayName: 'Ada Owner' }] })] });
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    expect(screen.getByText('Owned by you')).toBeInTheDocument();
    expect(screen.queryByText('Ada Owner')).not.toBeInTheDocument();
  });

  it('renders an empty state when there are no public lakes', () => {
    mockHook({ pages: [{ data: [], total: 0 }] });
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    expect(screen.getByTestId('datalake-discover-empty')).toBeInTheDocument();
  });

  it('passes the typed search query through to the hook', async () => {
    mockHook();
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    await userEvent.type(screen.getByTestId('datalake-discover-search').querySelector('input')!, 'sales');
    // Offset paging keeps a fixed page size, so the hook takes only the (debounced) search term.
    expect(useBrowsePublicDataLakes).toHaveBeenLastCalledWith('sales');
  });

  it('fetches the next page on Load more only while there is one, and never grows the request', async () => {
    mockHook({ hasNextPage: true });
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    // The hook is always called with just the search term - Load more advances offset internally,
    // so a deep load-more can never push `limit` past the route cap (the bug this guards against).
    expect(useBrowsePublicDataLakes).toHaveBeenLastCalledWith('');
    await userEvent.click(screen.getByTestId('datalake-discover-load-more'));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('hides Load more when there is no next page', () => {
    mockHook({ hasNextPage: false });
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    expect(screen.queryByTestId('datalake-discover-load-more')).not.toBeInTheDocument();
  });

  it('surfaces an error state', () => {
    useBrowsePublicDataLakes.mockReturnValue(mockState({ isError: true, pages: [] }));
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    expect(screen.getByTestId('datalake-discover-error')).toBeInTheDocument();
  });
});
