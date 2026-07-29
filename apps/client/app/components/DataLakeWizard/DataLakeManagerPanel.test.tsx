import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeManagerPanel from './DataLakeManagerPanel';

vi.mock('@client/app/hooks/data/dataLakes', () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useArchiveDataLake: mutation,
    useUnarchiveDataLake: mutation,
    useRestoreDeletedDataLake: mutation,
    usePermanentDeleteDataLake: mutation,
    useCleanupDataLake: mutation,
    useGetArchivedDataLakes: () => ({ data: undefined }),
    useGetDeletedDataLakes: () => ({ data: undefined }),
  };
});

const lakeFiles = [
  { id: 'f1', fileName: 'war.md', tags: [{ name: 'lk:genre:war' }] },
  { id: 'f2', fileName: 'peace.md', tags: [{ name: 'lk:genre:peace' }] },
  // No prefix-matching tag -> must surface under the Uncategorized bucket.
  { id: 'f3', fileName: 'loose.md', tags: [{ name: 'datalake:mine' }] },
];

const useDataLakes = vi.fn(() => ({ data: [] as unknown[], isLoading: false }));
vi.mock('@client/app/hooks/data/dataLakeWizard', () => ({
  useDataLakes: () => useDataLakes(),
  // Per-lake files: only the selected lake queries (id != null).
  useDataLakeFiles: (id: string | null) => ({
    data: id ? { data: lakeFiles } : undefined,
    isLoading: false,
    isError: false,
  }),
}));

// Count fallback for lakes whose list entry has no fileCount: same per-prefix unique
// counts that drive the in-chat tree.
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetDataLakeTagCounts: () => ({
    data: { tagCounts: [], uniqueArticleCounts: { total: 4, byPrefix: { 'lk:': 3, 'th:': 1 } } },
  }),
}));

// Default (flag on) is established per-describe; tests override per-case.
const isFeatureEnabled = vi.fn();
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled }),
}));

// The right-pane reader and the settings editor have their own suites - stub them so this
// one exercises only the manager's navigation/affordance wiring.
vi.mock('./DataLakeArticlePanel', () => ({
  default: ({ file }: { file: { fileName: string } | null }) => <div data-testid="mock-article">{file?.fileName}</div>,
}));
vi.mock('./DataLakeSettingsModal', () => ({
  DataLakeSettingsModal: ({ lake }: { lake: { name: string } | null }) =>
    lake ? <div data-testid="mock-settings">{lake.name}</div> : null,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// No fileCount on the list entry - the count chip must come from the tag-counts fallback.
const mineLake = {
  id: 'mine',
  name: 'Mine',
  slug: 'mine',
  fileTagPrefix: 'lk',
  datalakeTag: 'datalake:mine',
  description: 'my lake',
  canManage: true,
};

const theirsLake = {
  id: 'theirs',
  name: 'Theirs',
  slug: 'theirs',
  fileTagPrefix: 'th',
  datalakeTag: 'datalake:theirs',
  fileCount: 1,
  isPublic: true,
  canManage: false,
};

const renderPanel = () =>
  render(
    <Wrapper>
      <DataLakeManagerPanel />
    </Wrapper>
  );

beforeEach(() => {
  isFeatureEnabled.mockReset();
  isFeatureEnabled.mockReturnValue(true);
  useDataLakes.mockReset();
  useDataLakes.mockReturnValue({ data: [mineLake, theirsLake], isLoading: false });
});

describe('DataLakeManagerPanel - EnableDataLakes gating', () => {
  it('renders the panel when the feature is on', () => {
    renderPanel();
    expect(screen.getByTestId('datalake-manager-panel')).toBeInTheDocument();
  });

  it('renders nothing when the feature is off (shared choke point for every manager entry)', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');
    renderPanel();
    // The panel's lakes queries 403 when the feature is off, and its empty state is a
    // dead end - so the panel must not render at all, mirroring SendToDataLakeModal.
    expect(screen.queryByTestId('datalake-manager-panel')).not.toBeInTheDocument();
  });
});

describe('DataLakeManagerPanel - root view', () => {
  it('lists the lakes in the sidebar with file counts and shows the overview on the right', () => {
    renderPanel();
    expect(screen.getByTestId('datalake-manager-lake-mine')).toHaveTextContent('Mine');
    // fileCount is absent from the list entry, so this 3 proves the tag-counts fallback.
    expect(screen.getByTestId('datalake-manager-lake-mine')).toHaveTextContent('3');
    expect(screen.getByTestId('datalake-manager-lake-theirs')).toBeInTheDocument();
    // Sidebar accordions: lakes + the lifecycle sections; right pane shows the hint,
    // footer keeps Create.
    expect(screen.getByTestId('datalake-manager-lakes-section')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-archived-section')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-deleted-section')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-overview')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-create-btn')).toBeInTheDocument();
  });

  it('collapses the Data Lakes accordion, hiding the lake rows', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('datalake-manager-lakes-section-toggle'));
    expect(screen.queryByTestId('datalake-manager-lake-mine')).not.toBeInTheDocument();
    // The lifecycle accordions are unaffected.
    expect(screen.getByTestId('datalake-archived-section')).toBeInTheDocument();
  });
});

describe('DataLakeManagerPanel - lake navigation', () => {
  it('opens a lake on its categories (prefix root skipped) with the lake info on the right', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));

    // Path is seeded past the 'lk' prefix, so categories show immediately.
    expect(screen.getByTestId('datalake-manager-node-genre')).toBeInTheDocument();
    // Untagged file is reachable through the fallback bucket.
    expect(screen.getByTestId('datalake-manager-uncategorized')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-lakeinfo')).toHaveTextContent('my lake');
  });

  it('drills to a leaf, opens a file on the right, and walks back up to the lakes root', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    await user.click(screen.getByTestId('datalake-manager-node-genre'));
    await user.click(screen.getByTestId('datalake-manager-node-war'));
    await user.click(screen.getByTestId('datalake-manager-file-f1'));
    expect(screen.getByTestId('mock-article')).toHaveTextContent('war.md');

    // Back: war files -> genre -> lake root -> all lakes.
    await user.click(screen.getByTestId('datalake-manager-back'));
    // Leaving a level clears the open file so the right pane matches the nav.
    expect(screen.queryByTestId('mock-article')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('datalake-manager-back'));
    await user.click(screen.getByTestId('datalake-manager-back'));
    expect(screen.getByTestId('datalake-manager-lake-mine')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-overview')).toBeInTheDocument();
  });
});

describe('DataLakeManagerPanel - management affordances gate on canManage', () => {
  it('shows Add files / Settings / Archive on a lake the caller can manage', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));

    expect(screen.getByTestId('datalake-addfiles-btn-mine')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-settings-btn-mine')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-archive-btn-mine')).toBeInTheDocument();
  });

  it("hides all three on a lake the caller cannot manage (someone else's public lake)", async () => {
    const user = userEvent.setup();
    renderPanel();

    // The read-only lake still opens - only the management affordances are gated.
    await user.click(screen.getByTestId('datalake-manager-lake-theirs'));

    expect(screen.getByTestId('datalake-manager-lakeinfo')).toHaveTextContent('Theirs');
    expect(screen.queryByTestId('datalake-addfiles-btn-theirs')).toBeNull();
    expect(screen.queryByTestId('datalake-settings-btn-theirs')).toBeNull();
    expect(screen.queryByTestId('datalake-archive-btn-theirs')).toBeNull();
  });

  it('opens the settings editor for the selected lake', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    await user.click(screen.getByTestId('datalake-settings-btn-mine'));

    expect(screen.getByTestId('mock-settings')).toHaveTextContent('Mine');
  });
});
