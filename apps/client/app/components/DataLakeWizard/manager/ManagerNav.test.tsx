import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ManagerNav from './ManagerNav';
import type { ManagerLake } from './shared';

// ManagerNav's root view reaches these hooks directly (lifecycle lists + in-lake files) -
// stub them so the render doesn't need a QueryClientProvider.
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useCleanupDataLake: () => ({ mutate: vi.fn(), isPending: false }),
  useDataLakeFiles: () => ({ data: undefined, isLoading: false, isError: false }),
  useGetArchivedDataLakes: () => ({ data: undefined }),
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
