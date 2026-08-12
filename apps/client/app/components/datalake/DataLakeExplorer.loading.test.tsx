import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeNav } from './dataLakeNavContext';
import DataLakeExplorer from './DataLakeExplorer';

// "docs:policy" is tagged directly (own files) AND is the parent of "docs:policy:v2" - a mixed
// branch node. Its own-tagged files still need a fetch, but the subfolder list itself doesn't:
// it's already available from tagCounts, so the pane must not blank to a skeleton while that
// fetch is in flight. "docs:policy:v2" is a true leaf, where nothing renders without its fetch,
// so that case is a regression control - it must stay gated on isLoading as before.
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  activeOrgId: () => undefined,
  useGetDataLakeTagCounts: () => ({
    data: {
      tagCounts: [
        { tag: 'docs:policy', count: 2 },
        { tag: 'docs:policy:v2', count: 5 },
      ],
      uniqueArticleCounts: { total: 7 },
    },
    isLoading: false,
    isError: false,
  }),
  useGetDataLakeArticles: (params?: { tags?: string[] } | null) => {
    const tag = params?.tags?.[0];
    if (tag === 'docs:policy' || tag === 'docs:policy:v2') {
      return { data: undefined, isLoading: true };
    }
    return { data: { data: [] }, isLoading: false };
  },
}));

vi.mock('@client/app/contexts/SessionsContext', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/contexts/SessionsContext')>()),
  useSessions: () => ({ currentSessionId: 'sess-1' }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/hooks/useSetDataLakeMode', () => ({ default: () => vi.fn() }));
vi.mock('@client/app/components/DataLakeWizard/DataLakeIngestPickerModal', () => ({ default: () => null }));
vi.mock('@client/app/components/layouts/Notebook', () => ({
  useNotebookLayout: (sel: (s: { openSideNav: boolean }) => unknown) => sel({ openSideNav: true }),
}));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

// Surface the isLoading prop the Explorer computes so the fix can be asserted directly.
vi.mock('./DataLakeChatTree', () => ({
  default: ({ isLoading, breadcrumb }: { isLoading: boolean; breadcrumb: string[] }) => (
    <div data-testid="mock-tree" data-loading={String(isLoading)} data-breadcrumb={breadcrumb.join('/')} />
  ),
}));

// Drives navigation the same way the chatSlot host does elsewhere in this suite.
function NavProbe() {
  const nav = useDataLakeNav();
  if (!nav) return null;
  return (
    <>
      <button data-testid="nav-to-mixed" onClick={() => nav.navigate(['docs', 'policy'])}>
        mixed
      </button>
      <button data-testid="nav-to-leaf" onClick={() => nav.navigate(['docs', 'policy', 'v2'])}>
        leaf
      </button>
    </>
  );
}

const appTheme = extendTheme({ ...getThemeConfig() });
const renderExplorer = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <DataLakeExplorer source="datalakes" chatSlot={<NavProbe />} />
    </CssVarsProvider>
  );

describe('DataLakeExplorer -- loading state at a mixed branch node', () => {
  it("does not blank the folder list while a mixed node's own-files fetch is in flight", () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId('nav-to-mixed'));
    const tree = screen.getByTestId('mock-tree');
    expect(tree).toHaveAttribute('data-breadcrumb', 'docs/policy');
    expect(tree).toHaveAttribute('data-loading', 'false');
  });

  it('still shows loading at a true leaf whose only content is the in-flight fetch', () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId('nav-to-leaf'));
    const tree = screen.getByTestId('mock-tree');
    expect(tree).toHaveAttribute('data-breadcrumb', 'docs/policy/v2');
    expect(tree).toHaveAttribute('data-loading', 'true');
  });
});
