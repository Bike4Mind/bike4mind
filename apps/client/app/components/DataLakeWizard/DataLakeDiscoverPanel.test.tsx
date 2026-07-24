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

const result = (overrides: Partial<BrowsePublicDataLakesResult> = {}): BrowsePublicDataLakesResult => ({
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

const mockHook = (value: Partial<ReturnType<typeof mockState>> = {}) =>
  useBrowsePublicDataLakes.mockReturnValue(mockState(value));

const mockState = (
  value: Partial<{ data: BrowsePublicDataLakesResult; isLoading: boolean; isFetching: boolean; isError: boolean }> = {}
) => ({
  data: result(),
  isLoading: false,
  isFetching: false,
  isError: false,
  ...value,
});

describe('DataLakeDiscoverPanel', () => {
  beforeEach(() => {
    useBrowsePublicDataLakes.mockReset();
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

  it('shows an "Owned by you" chip and hides the owner chip for the caller’s own lake', () => {
    mockHook({
      data: result({
        data: [{ ...result().data[0], isOwn: true, ownerDisplayName: 'Ada Owner' }],
      }),
    });
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    expect(screen.getByText('Owned by you')).toBeInTheDocument();
    expect(screen.queryByText('Ada Owner')).not.toBeInTheDocument();
  });

  it('renders an empty state when there are no public lakes', () => {
    mockHook({ data: result({ data: [], total: 0 }) });
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    expect(screen.getByTestId('datalake-discover-empty')).toBeInTheDocument();
  });

  it('passes the typed search query through to the hook', async () => {
    mockHook();
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    await userEvent.type(screen.getByTestId('datalake-discover-search').querySelector('input')!, 'sales');
    // Latest call reflects the debounced (here: immediate) query at the default page size.
    expect(useBrowsePublicDataLakes).toHaveBeenLastCalledWith('sales', 24);
  });

  it('grows the page size when Load more is clicked', async () => {
    mockHook({ data: result({ total: 100 }) });
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    await userEvent.click(screen.getByTestId('datalake-discover-load-more'));
    expect(useBrowsePublicDataLakes).toHaveBeenLastCalledWith('', 48);
  });

  it('surfaces an error state', () => {
    mockHook({ isError: true, data: undefined as unknown as BrowsePublicDataLakesResult });
    render(<DataLakeDiscoverPanel />, { wrapper: TestWrapper });

    expect(screen.getByTestId('datalake-discover-error')).toBeInTheDocument();
  });
});
