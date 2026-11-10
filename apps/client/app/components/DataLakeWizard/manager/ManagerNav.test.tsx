import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { countTagPaths } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import ManagerNav from './ManagerNav';
import type { ManagerLake } from './shared';

type TestFile = { id: string; fileName: string; tags: { name: string }[] };
type QueryState = { isLoading: boolean; isError: boolean };

// The open lake as the server would answer for it, set per test; undefined is "no lake open".
// `firstPage` is the lake's unfiltered file list, which the route caps at 100 files.
const lake = vi.hoisted(() => {
  const state = {
    firstPage: undefined as TestFile[] | undefined,
    tagCounts: undefined as { tag: string; count: number; fileCount: number }[] | undefined,
    counts: { isLoading: false, isError: false } as QueryState,
    uncategorized: undefined as { data: TestFile[]; total: number } | undefined,
    bucket: { isLoading: false, isError: false } as QueryState,
    byTag: {} as Record<string, TestFile[]>,
    folder: { isLoading: false, isError: false } as QueryState,
  };
  const reset = () => {
    state.firstPage = undefined;
    state.tagCounts = undefined;
    state.counts = { isLoading: false, isError: false };
    state.uncategorized = undefined;
    state.bucket = { isLoading: false, isError: false };
    state.byTag = {};
    state.folder = { isLoading: false, isError: false };
  };
  return { state, reset };
});
const useDataLakeFiles = vi.hoisted(() =>
  vi.fn((id: string | null, params?: { tag?: string }) => {
    const { state } = lake;
    if (!id) return { data: undefined, isLoading: false, isError: false };
    if (params?.tag) {
      const files = state.byTag[params.tag] ?? [];
      return { data: { data: files, total: files.length }, ...state.folder };
    }
    return { data: state.firstPage ? { data: state.firstPage } : undefined, isLoading: false, isError: false };
  })
);

// ManagerNav's root view reaches these hooks directly (lifecycle lists + in-lake tree) -
// stub them so the render doesn't need a QueryClientProvider.
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useCleanupDataLake: () => ({ mutate: vi.fn(), isPending: false }),
  useDataLakeFiles,
  useGetArchivedDataLakes: () => ({ data: undefined }),
  // The in-lake tree's cross-tree search; idle with no query.
  useGetDataLakeArticles: () => ({ data: undefined, isLoading: false }),
  useGetDataLakeUncategorizedFiles: (id: string | null) => ({
    data: id ? lake.state.uncategorized : undefined,
    ...lake.state.bucket,
  }),
  useGetDeletedDataLakes: () => ({ data: undefined }),
  useGetScopedDataLakeTagCounts: (_source: string, lakeIds: readonly string[]) => ({
    data: lakeIds.length > 0 && lake.state.tagCounts ? { tagCounts: lake.state.tagCounts } : undefined,
    ...lake.state.counts,
  }),
  useGetTransitionalDataLakes: () => ({ data: undefined }),
  usePermanentDeleteDataLake: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreDeletedDataLake: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryLakeLifecycle: () => ({ mutate: vi.fn(), isPending: false }),
  useUnarchiveDataLake: () => ({ mutate: vi.fn(), isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const baseProps = {
  lakesLoading: false,
  lakeCount: () => 0,
  taxonomyBatchByLakeId: new Map(),
  activeLake: null,
  path: [],
  selectedFileId: null,
  onSelectLake: vi.fn(),
  onNavigate: vi.fn(),
  onExitLake: vi.fn(),
  onSelectFile: vi.fn(),
  onCreateLake: vi.fn(),
  onDiscover: vi.fn(),
  onReviewTaxonomy: vi.fn(),
};

const makeLake = (overrides: Partial<ManagerLake>): ManagerLake =>
  ({
    id: 'lake-1',
    slug: 'lake-1',
    name: 'Lake 1',
    fileTagPrefix: 'lk',
    datalakeTag: 'datalake:lake-1',
    ...overrides,
  }) as ManagerLake;

describe('ManagerNav origin chip', () => {
  it('badges a connector-fed lake', () => {
    render(
      <TestWrapper>
        <ManagerNav {...baseProps} lakes={[makeLake({ id: 'lake-1', name: 'Drive Docs', origin: 'connector-fed' })]} />
      </TestWrapper>
    );
    expect(screen.getByTestId('datalake-manager-origin-lake-1')).toHaveTextContent(/connector/i);
  });

  it('renders no chip for a curated lake', () => {
    render(
      <TestWrapper>
        <ManagerNav {...baseProps} lakes={[makeLake({ id: 'lake-1', name: 'Hand Built', origin: 'curated' })]} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('datalake-manager-origin-lake-1')).toBeNull();
  });
});

describe('ManagerNav lake name', () => {
  it('exposes the full name on a row crowded by status chips', () => {
    render(
      <TestWrapper>
        <ManagerNav
          {...baseProps}
          lakeCount={() => 12}
          lakes={[
            makeLake({
              id: 'lake-1',
              name: 'Vendor Contracts',
              status: 'draft',
              canManage: true,
              pendingProposalCount: 3,
              origin: 'connector-fed',
            }),
          ]}
        />
      </TestWrapper>
    );
    const name = screen.getByTestId('datalake-manager-lake-name-lake-1');
    expect(name).toHaveTextContent('Vendor Contracts');
    expect(name).toHaveAttribute('aria-label', 'Vendor Contracts');
    expect(screen.getByTestId('datalake-manager-draft-chip-lake-1')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-pending-proposals-lake-1')).toBeInTheDocument();
  });
});

describe('ManagerNav draft chip', () => {
  it('marks a draft lake in the list and leaves a published one unmarked', () => {
    render(
      <TestWrapper>
        <ManagerNav
          {...baseProps}
          lakes={[
            makeLake({ id: 'lake-1', name: 'Draft Lake', status: 'draft', canManage: true }),
            makeLake({ id: 'lake-2', name: 'Live Lake', fileTagPrefix: 'live', status: 'active', canManage: true }),
          ]}
        />
      </TestWrapper>
    );
    expect(screen.getByTestId('datalake-manager-draft-chip-lake-1')).toHaveTextContent('Draft');
    expect(screen.queryByTestId('datalake-manager-draft-chip-lake-2')).toBeNull();
  });
});

const makeFile = (id: string, tags: string[]): TestFile => ({
  id,
  fileName: `${id}.md`,
  tags: [{ name: 'datalake:lake-1' }, ...tags.map(name => ({ name }))],
});
const makeFiles = (prefix: string, n: number, tags: string[]) =>
  Array.from({ length: n }, (_, i) => makeFile(`${prefix}${i}`, tags));
// What the tag-counts route answers for a lake: every path under the prefix, counted per file.
const countsFor = (files: TestFile[], prefix: string) =>
  countTagPaths(files.map(f => f.tags.map(t => t.name).filter(name => name.startsWith(prefix))));

const renderInLake = (activeLake: ManagerLake, path: string[]) =>
  render(
    <TestWrapper>
      <ManagerNav {...baseProps} lakes={[activeLake]} activeLake={activeLake} path={path} />
    </TestWrapper>
  );

describe('ManagerNav lake tree counts', () => {
  afterEach(() => {
    lake.reset();
    useDataLakeFiles.mockClear();
  });

  it('shows the distinct file count the server gives a branch over multi-tagged files', () => {
    const leaves = ['acme:legal:a', 'acme:legal:b', 'acme:legal:c', 'acme:legal:d'];
    lake.state.tagCounts = countsFor(
      ['f1', 'f2', 'f3'].map(id => makeFile(id, leaves)),
      'acme:'
    );

    renderInLake(makeLake({ fileTagPrefix: 'acme:' }), ['acme']);

    // Summing the four leaves read 12.
    expect(screen.getByTestId('datalake-manager-node-legal')).toHaveTextContent(/^Legal3$/);
  });

  // A 211-file lake whose first page of 100 holds 50 Reproduction and 28 Results files and no
  // Appendix file at all.
  const reproduction = makeFiles('r', 85, ['lk:reproduction']);
  const results = makeFiles('s', 73, ['lk:results']);
  const appendix = makeFiles('a', 31, ['lk:appendix']);
  const loose = makeFiles('u', 22, []);
  const bigLake = () => {
    lake.state.firstPage = [...reproduction.slice(0, 50), ...results.slice(0, 28), ...loose];
    lake.state.tagCounts = countsFor([...reproduction, ...results, ...appendix, ...loose], 'lk:');
    lake.state.uncategorized = { data: loose, total: loose.length };
    lake.state.byTag = { 'lk:appendix': appendix, 'lk:results': results.slice(0, 100) };
  };

  it('counts every folder over the whole lake, not over the first page of files', () => {
    bigLake();

    renderInLake(makeLake({}), ['lk']);

    expect(screen.getByTestId('datalake-manager-node-reproduction')).toHaveTextContent(/^Reproduction85$/);
    expect(screen.getByTestId('datalake-manager-node-results')).toHaveTextContent(/^Results73$/);
    expect(screen.getByTestId('datalake-manager-node-appendix')).toHaveTextContent(/^Appendix31$/);
    expect(screen.getByTestId('datalake-manager-uncategorized')).toHaveTextContent(/^Uncategorized22$/);
    // The lake root shows folders only, so no folder's files are fetched yet.
    expect(useDataLakeFiles.mock.calls.filter(([, params]) => params?.tag)).toEqual([]);
  });

  it('lists the files of a folder that has none on the first page, fetched by its tag', () => {
    bigLake();

    renderInLake(makeLake({}), ['lk', 'appendix']);

    expect(useDataLakeFiles).toHaveBeenCalledWith('lake-1', { tag: 'lk:appendix' });
    expect(screen.getAllByTestId(/^datalake-manager-file-/)).toHaveLength(31);
    expect(screen.getByTestId('datalake-manager-file-a30')).toBeInTheDocument();
  });

  it('lists a branch folder its own files beside its subfolders', () => {
    const overview = [makeFile('o1', ['lk:genre'])];
    const war = makeFiles('w', 3, ['lk:genre:war']);
    lake.state.tagCounts = countsFor([...overview, ...war], 'lk:');
    lake.state.byTag = { 'lk:genre': overview };

    renderInLake(makeLake({}), ['lk', 'genre']);

    expect(useDataLakeFiles).toHaveBeenCalledWith('lake-1', { tag: 'lk:genre' });
    expect(screen.getByTestId('datalake-manager-node-war')).toHaveTextContent(/^War3$/);
    expect(screen.getByTestId('datalake-manager-file-o1')).toBeInTheDocument();
  });

  it('counts the whole Uncategorized bucket, not the page of it that is listed', () => {
    const bucket = makeFiles('u', 100, []);
    lake.state.firstPage = bucket;
    lake.state.tagCounts = [];
    lake.state.uncategorized = { data: bucket, total: 140 };

    renderInLake(makeLake({}), ['lk']);

    expect(screen.getByTestId('datalake-manager-uncategorized')).toHaveTextContent(/^Uncategorized140$/);
    // The lake root is not a folder, even with no category under it.
    expect(useDataLakeFiles.mock.calls.filter(([, params]) => params?.tag)).toEqual([]);
  });

  it('lists the open Uncategorized bucket without fetching a folder for its key', () => {
    bigLake();

    renderInLake(makeLake({}), ['lk', '__uncategorized__']);

    expect(screen.getAllByTestId(/^datalake-manager-file-/)).toHaveLength(22);
    expect(useDataLakeFiles.mock.calls.filter(([, params]) => params?.tag)).toEqual([]);
  });

  it('shows the skeleton, not an empty tree, while the counts load', () => {
    bigLake();
    lake.state.tagCounts = undefined;
    lake.state.counts = { isLoading: true, isError: false };

    renderInLake(makeLake({}), ['lk']);

    expect(screen.queryByText('No categories')).toBeNull();
    expect(screen.queryByTestId('datalake-manager-uncategorized')).toBeNull();
    expect(screen.queryByTestId('datalake-manager-error')).toBeNull();
  });

  it('shows the skeleton while the Uncategorized bucket loads', () => {
    bigLake();
    lake.state.uncategorized = undefined;
    lake.state.bucket = { isLoading: true, isError: false };

    renderInLake(makeLake({}), ['lk']);

    expect(screen.queryByTestId('datalake-manager-node-reproduction')).toBeNull();
  });

  it('shows the error row when the Uncategorized bucket fails', () => {
    bigLake();
    lake.state.uncategorized = undefined;
    lake.state.bucket = { isLoading: false, isError: true };

    renderInLake(makeLake({}), ['lk']);

    expect(screen.getByTestId('datalake-manager-error')).toBeInTheDocument();
  });

  it('fetches no folder while the counts that say what a folder is are still loading', () => {
    bigLake();
    lake.state.tagCounts = undefined;
    lake.state.counts = { isLoading: true, isError: false };

    renderInLake(makeLake({}), ['lk', 'appendix']);

    expect(useDataLakeFiles.mock.calls.filter(([, params]) => params?.tag)).toEqual([]);
  });

  it('shows the error row when the counts fail', () => {
    bigLake();
    lake.state.tagCounts = undefined;
    lake.state.counts = { isLoading: false, isError: true };

    renderInLake(makeLake({}), ['lk']);

    expect(screen.getByTestId('datalake-manager-error')).toHaveTextContent('Failed to load files');
  });

  it('shows the error row when an open folder fails to load its files', () => {
    bigLake();
    lake.state.folder = { isLoading: false, isError: true };

    renderInLake(makeLake({}), ['lk', 'appendix']);

    expect(screen.getByTestId('datalake-manager-error')).toBeInTheDocument();
  });

  it('lists a branch folder its subfolders while its own files are still loading', () => {
    const overview = [makeFile('o1', ['lk:genre'])];
    lake.state.tagCounts = countsFor([...overview, ...makeFiles('w', 3, ['lk:genre:war'])], 'lk:');
    lake.state.folder = { isLoading: true, isError: false };

    renderInLake(makeLake({}), ['lk', 'genre']);

    expect(screen.getByTestId('datalake-manager-node-war')).toBeInTheDocument();
  });

  it('holds the skeleton at a folder until its files arrive', () => {
    bigLake();
    lake.state.folder = { isLoading: true, isError: false };
    lake.state.byTag = {};

    renderInLake(makeLake({}), ['lk', 'appendix']);

    expect(screen.queryByText('No files found')).toBeNull();
  });
});
