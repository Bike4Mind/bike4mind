import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ManagerNav from './ManagerNav';
import type { ManagerLake } from './shared';

// The active lake's member files, set per test; undefined is the "no lake open" default.
const lakeFiles = vi.hoisted(() => ({ current: undefined as unknown[] | undefined }));

// ManagerNav's root view reaches these hooks directly (lifecycle lists + in-lake files) -
// stub them so the render doesn't need a QueryClientProvider.
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useCleanupDataLake: () => ({ mutate: vi.fn(), isPending: false }),
  useDataLakeFiles: () => ({
    data: lakeFiles.current ? { data: lakeFiles.current } : undefined,
    isLoading: false,
    isError: false,
  }),
  useGetArchivedDataLakes: () => ({ data: undefined }),
  // The in-lake tree's cross-tree search; idle with no query.
  useGetDataLakeArticles: () => ({ data: undefined, isLoading: false }),
  useGetDeletedDataLakes: () => ({ data: undefined }),
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

describe('ManagerNav lake tree counts', () => {
  afterEach(() => {
    lakeFiles.current = undefined;
  });

  it('counts a branch over multi-tagged files once per file', () => {
    const leaves = ['acme:legal:a', 'acme:legal:b', 'acme:legal:c', 'acme:legal:d'];
    lakeFiles.current = ['f1', 'f2', 'f3'].map(id => ({
      id,
      fileName: `${id}.md`,
      tags: [{ name: 'datalake:lake-1' }, ...leaves.map(name => ({ name }))],
    }));
    const lake = makeLake({ fileTagPrefix: 'acme:' });

    render(
      <TestWrapper>
        <ManagerNav {...baseProps} lakes={[lake]} activeLake={lake} path={['acme']} />
      </TestWrapper>
    );

    // Summing the four leaves read 12.
    expect(screen.getByTestId('datalake-manager-node-legal')).toHaveTextContent('3');
  });
});
