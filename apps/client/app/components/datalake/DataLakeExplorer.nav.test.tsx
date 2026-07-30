import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeNav } from './dataLakeNavContext';
import DataLakeExplorer from './DataLakeExplorer';

// A 2-level tag structure so buildTagTree yields prefix -> children with counts. The Explorer
// exposes the richest second-level branches (sorted, top 6) + tree navigation via context.
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetDataLakeTagCounts: () => ({
    data: {
      tagCounts: [
        { tag: 'books:business', count: 3 },
        { tag: 'books:philosophy', count: 2 },
        { tag: 'competitors:acme', count: 2 },
      ],
      uniqueArticleCounts: { total: 7 },
    },
    isLoading: false,
    isError: false,
  }),
  useGetDataLakeArticles: () => ({ data: { data: [] }, isLoading: false }),
}));

vi.mock('@client/app/contexts/SessionsContext', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/contexts/SessionsContext')>()),
  useSessions: () => ({ currentSessionId: 'sess-1' }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/hooks/useSetDataLakeMode', () => ({ default: () => vi.fn() }));
vi.mock('@client/app/components/DataLakeWizard/DataLakeIngestPickerModal', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

// Surface the breadcrumb the Explorer passes down so we can assert navigate() drilled the tree.
vi.mock('./DataLakeTree', () => ({
  default: ({ breadcrumb }: { breadcrumb: string[] }) => (
    <div data-testid="mock-tree" data-breadcrumb={breadcrumb.join('/')} />
  ),
}));

// chatSlot probe: reads the provided nav context and renders it, mirroring how the overlay
// sonar consumes DataLakeExplorer's richest branches + navigate.
function NavProbe() {
  const nav = useDataLakeNav();
  if (!nav) return <div data-testid="no-nav" />;
  return (
    <div data-testid="nav-probe" data-dives={nav.quickDives.map(d => `${d.segment}:${d.count}`).join(',')}>
      {nav.quickDives.map(d => (
        <button
          key={d.path.join('-')}
          data-testid={`probe-dive-${d.path.join('-')}`}
          onClick={() => nav.navigate(d.path)}
        >
          {d.segment}
        </button>
      ))}
    </div>
  );
}

const appTheme = extendTheme({ ...getThemeConfig() });
const renderExplorer = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <DataLakeExplorer source="datalakes" chatSlot={<NavProbe />} />
    </CssVarsProvider>
  );

describe('DataLakeExplorer -- DataLakeNav context around chatSlot', () => {
  it('provides the richest second-level branches (sorted by count) to the chatSlot', () => {
    renderExplorer();
    // business(3) before the two 2-counts; all three surfaced.
    expect(screen.getByTestId('nav-probe')).toHaveAttribute('data-dives', 'business:3,philosophy:2,acme:2');
  });

  it('navigate(path) from the chatSlot drills the tree breadcrumb', () => {
    renderExplorer();
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-breadcrumb', '');
    fireEvent.click(screen.getByTestId('probe-dive-books-business'));
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-breadcrumb', 'books/business');
  });
});
