import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeExplorer from './DataLakeExplorer';

const { fetchCalls, tagCountsState } = vi.hoisted(() => ({
  fetchCalls: [] as string[],
  tagCountsState: { tagCounts: [] as { tag: string; count: number; fileCount?: number }[] },
}));

vi.mock('@client/app/contexts/SessionsContext', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/contexts/SessionsContext')>()),
  useSessions: () => ({
    currentSessionId: 'sess-1',
    currentSession: { id: 'sess-1', retrievalTags: [], lakeScopeExplicit: false },
  }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
  useWorkBenchFiles: () => [],
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  activeOrgId: () => undefined,
  useGetDataLakeTagCounts: () => ({
    data: {
      tagCounts: tagCountsState.tagCounts,
      uniqueArticleCounts: { total: 2 },
      totalLakeFileCount: 2,
      lakeFileCounts: { 'datalake:lakea': 2 },
      uncategorizedFileCounts: { 'datalake:lakea': 2 },
    },
    isLoading: false,
    isError: false,
  }),
  useGetDataLakeUncategorizedFiles: (lakeId: string | null, enabled: boolean) => {
    if (enabled && lakeId) fetchCalls.push(lakeId);
    return {
      data: {
        data: [
          { id: 'f1', fileName: 'first', tags: [] },
          { id: 'f2', fileName: 'second', tags: [] },
        ],
        total: 2,
      },
      isLoading: false,
      isError: false,
    };
  },
  useGetDataLakeArticles: () => ({ data: { data: [] }, isLoading: false }),
  useGetDataLakes: () => ({ data: lakes }),
  useGetDataLakesWithRetrievability: () => ({ data: lakes, isLoading: false, isError: false }),
  useRemoveFileFromDataLake: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFileContent: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('@client/app/components/DataLakeWizard/DataLakeIngestPickerModal', () => ({ default: () => null }));
vi.mock('./DataLakeRailViewer', () => ({ default: () => <div data-testid="datalake-rail-viewer" /> }));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled: () => true, isFeatureEnabled: () => true, isLoading: false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: { isAdmin: boolean; currentUser: { id: string } }) => unknown) =>
    selector ? selector({ isAdmin: true, currentUser: { id: 'owner-1' } }) : { isAdmin: true },
}));
vi.mock('@client/app/stores/useDataLakeWizardStore', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/stores/useDataLakeWizardStore')>()),
  useDataLakeWizardStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ openManager: vi.fn(), openWizardForLake: vi.fn() }),
}));
vi.mock('@client/app/components/layouts/Notebook', () => ({
  useNotebookLayout: (sel: (s: { openSideNav: boolean }) => unknown) => sel({ openSideNav: true }),
}));
vi.mock('@client/app/hooks/useSetDataLakeMode', () => ({ default: () => vi.fn() }));
vi.mock('@client/app/hooks/useSetLakeScope', () => ({ default: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

const lakes = [
  { id: 'lake-a-id', name: 'Lake A', datalakeTag: 'datalake:lakea', fileTagPrefix: 'lakea:', canManage: true },
];

const appTheme = extendTheme({ ...getThemeConfig() });

describe('DataLakeExplorer with the real tree: uncategorized bucket in a childless lake folder', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    tagCountsState.tagCounts = [];
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('keeps the bucket out of the merged root and shows it inside the lake folder', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <DataLakeExplorer source="datalakes" chatSlot={<div />} chatEmbedded />
      </CssVarsProvider>
    );

    expect(screen.queryByTestId('datalake-node-uncategorized')).toBeNull();
    expect(fetchCalls).toEqual([]);

    fireEvent.click(screen.getByTestId('datalake-node-lakea'));

    const bucketRow = screen.getByTestId('datalake-node-uncategorized');
    expect(bucketRow).toHaveTextContent('Uncategorized');
    expect(bucketRow).toHaveTextContent('2');

    fireEvent.change(screen.getByTestId('datalake-search').querySelector('input')!, { target: { value: 'x' } });
    expect(screen.queryByTestId('datalake-node-uncategorized')).toBeNull();
    fireEvent.change(screen.getByTestId('datalake-search').querySelector('input')!, { target: { value: '' } });

    fireEvent.click(screen.getByTestId('datalake-node-uncategorized'));
    expect(fetchCalls).toContain('lake-a-id');
    expect(screen.getByTestId('datalake-file-f1')).toHaveTextContent('first');
    expect(screen.getByTestId('datalake-file-f2')).toHaveTextContent('second');
  });
});

describe('DataLakeExplorer with the real tree: inner rows from server-shaped counts', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  // The rows countDataLakeTagsByPrefix returns for 3 files each tagged lakea:legal:{a,b,c,d}.
  it('shows the distinct file count on an inner row, not the sum of its leaves', () => {
    tagCountsState.tagCounts = [
      { tag: 'lakea', count: 0, fileCount: 3 },
      { tag: 'lakea:legal', count: 0, fileCount: 3 },
      ...['a', 'b', 'c', 'd'].map(leaf => ({ tag: `lakea:legal:${leaf}`, count: 3, fileCount: 3 })),
    ];
    render(
      <CssVarsProvider theme={appTheme}>
        <DataLakeExplorer source="datalakes" chatSlot={<div />} chatEmbedded />
      </CssVarsProvider>
    );

    fireEvent.click(screen.getByTestId('datalake-node-lakea'));

    expect(screen.getByTestId('datalake-nodecount-legal')).toHaveTextContent(/^3$/);
  });
});
