import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import DataLakeManagerPanel from './DataLakeManagerPanel';

// Archive resolves synchronously so the onSuccess (exit-to-root) wiring is exercised.
const archiveMutate = vi.fn((_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
// Same for the active-lake delete button, so its onSuccess (exit-to-root) wiring is exercised too.
const deleteMutate = vi.fn((_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
// Same for purge, so the confirm dialog's close-on-success wiring is exercised.
const cleanupMutate = vi.fn((_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
const useActiveDataLakeBatches = vi.fn(() => ({ data: [] as unknown[] }));
// Lifecycle lists default to in-flight (undefined); a test can resolve them to drive the
// empty-section rendering.
const useGetArchivedDataLakes = vi.fn(() => ({ data: undefined as unknown[] | undefined }));
const useGetDeletedDataLakes = vi.fn(() => ({ data: undefined as unknown[] | undefined }));
vi.mock('@client/app/hooks/data/dataLakes', () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useArchiveDataLake: () => ({ mutate: archiveMutate, isPending: false }),
    useUnarchiveDataLake: mutation,
    useRestoreDeletedDataLake: mutation,
    usePermanentDeleteDataLake: () => ({ mutate: deleteMutate, isPending: false }),
    useCleanupDataLake: () => ({ mutate: cleanupMutate, isPending: false }),
    useGetArchivedDataLakes: () => useGetArchivedDataLakes(),
    useGetDeletedDataLakes: () => useGetDeletedDataLakes(),
    useActiveDataLakeBatches: () => useActiveDataLakeBatches(),
    useGetDataLakes: () => useGetDataLakes(),
    // LakeInfoPanel renders <LakeHealthBadge> unconditionally; the badge renders null on no data.
    useGetDataLakeHealth: () => ({ data: undefined, isLoading: false }),
    // Default: no rebuild backlog, so the "Rebuild passages" button/chips stay hidden. A test that
    // needs a backlog overrides via useUnderChunkedCount.mockReturnValue(...).
    useUnderChunkedCount: (...args: unknown[]) => useUnderChunkedCount(...(args as [string, boolean])),
    useRechunkDataLake: mutation,
    // Per-lake files: only the selected lake queries (id != null).
    useDataLakeFiles: (id: string | null) => ({
      data: id ? { data: lakeFiles } : undefined,
      isLoading: false,
      isError: false,
    }),
    // Per-lake counts come from lakeFileCounts (membership), NOT from the per-prefix tag counts.
    // The two disagree here on purpose: `theirs` has taxonomy tags but only 2 member files, and
    // `mine` has member files with NO taxonomy tag at all - the shape that used to display 0.
    useGetDataLakeTagCounts: () => ({
      data: {
        tagCounts: [],
        uniqueArticleCounts: { total: 4, byPrefix: { 'lk:': 0, 'th:': 9 } },
        lakeFileCounts: { 'datalake:mine': 3, 'datalake:theirs': 2 },
      },
    }),
  };
});

// TaxonomyReviewPanel has its own suite; here we only assert the manager opens it with the
// right batch (asserted via a data attribute mirroring the real component's props).
vi.mock('./TaxonomyReviewPanel', () => ({
  default: ({
    batch,
    prefix,
    onClose,
  }: {
    batch: { id: string; taxonomyStatus: string };
    prefix: string;
    onClose: () => void;
  }) => (
    <div
      data-testid="mock-taxonomy-review-panel"
      data-batch-id={batch.id}
      data-batch-status={batch.taxonomyStatus}
      data-prefix={prefix}
    >
      <button data-testid="mock-taxonomy-review-close" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

const lakeFiles = [
  { id: 'f1', fileName: 'war.md', tags: [{ name: 'lk:genre:war' }] },
  { id: 'f2', fileName: 'peace.md', tags: [{ name: 'lk:genre:peace' }] },
  // No prefix-matching tag -> must surface under the Uncategorized bucket.
  { id: 'f3', fileName: 'loose.md', tags: [{ name: 'datalake:mine' }] },
  // A BARE prefix is not a category anyone can navigate to, so the server counts this file as
  // uncategorized and the backfill stamps it. This bucket has to agree, or the file is reachable
  // from neither the tree nor here.
  { id: 'f4', fileName: 'bare.md', tags: [{ name: 'datalake:mine' }, { name: 'lk:' }] },
  // Tagged with "genre" itself, not a deeper child - "genre" is ALSO the parent of war/peace
  // above, so this file must stay reachable once genre has subfolders.
  { id: 'f5', fileName: 'genre-overview.md', tags: [{ name: 'lk:genre' }] },
  // Bracket-prefixed source names, all under one leaf - group by category then title, not the
  // raw leading "[" (which would put every one of these in the same "no signal" bucket).
  { id: 'f6', fileName: '[Marketing] Zebra Plan.md', tags: [{ name: 'lk:briefs:x' }] },
  { id: 'f7', fileName: '[Marketing] Apple Plan.md', tags: [{ name: 'lk:briefs:x' }] },
  { id: 'f8', fileName: '[Sales] Intro.md', tags: [{ name: 'lk:briefs:x' }] },
];

const useGetDataLakes = vi.fn(() => ({ data: [] as unknown[], isLoading: false }));
// Controllable per-test so a canRebuild-gating test can put a backlog on the lake, while the
// default (below, in beforeEach) keeps every other test's Rebuild button/chip hidden as before.
const useUnderChunkedCount = vi.fn(() => ({
  data: undefined as { underChunkedCount: number; failedCount: number } | undefined,
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
// The public catalog has its own suite; here we only assert the manager routes to it.
vi.mock('./DataLakeDiscoverPanel', () => ({
  default: () => <div data-testid="mock-discover" />,
}));
// LakeInfoPanel's "Start chat with this lake" button pulls in this hook, which reaches
// SessionsContext, react-router and react-query. This suite exercises the manager's navigation
// and affordance wiring, not the create-and-navigate flow, so stub the hook to a no-op.
vi.mock('@client/app/hooks/useStartChatWithLake', () => ({
  default: () => vi.fn(),
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
  canRebuild: true,
  isOwn: true,
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
  canRebuild: false,
  isOwn: false,
  ownerDisplayName: 'Ada Owner',
};

// A fallback (built-in) lake as an admin would see it: canManage is ALWAYS false for these (no
// document to manage), but canRebuild can still be true - the structural split this test file
// pins in the "canRebuild is narrower than canManage" describe block below.
const fallbackLakeAsAdmin = {
  id: 'opti-knowledge',
  name: 'Optimization Knowledge Base',
  slug: 'opti-knowledge',
  fileTagPrefix: 'opti:',
  datalakeTag: 'datalake:opti-knowledge',
  canManage: false,
  canRebuild: true,
  isOwn: false,
};

const renderPanel = () =>
  render(
    <Wrapper>
      <DataLakeManagerPanel />
    </Wrapper>
  );

const rerenderPanel = (rerender: (ui: ReactNode) => void) =>
  rerender(
    <Wrapper>
      <DataLakeManagerPanel />
    </Wrapper>
  );

beforeEach(() => {
  isFeatureEnabled.mockReset();
  isFeatureEnabled.mockReturnValue(true);
  useGetDataLakes.mockReset();
  useGetDataLakes.mockReturnValue({ data: [mineLake, theirsLake], isLoading: false });
  useUnderChunkedCount.mockReset();
  useUnderChunkedCount.mockReturnValue({ data: undefined });
  archiveMutate.mockClear();
  deleteMutate.mockClear();
  cleanupMutate.mockClear();
  useGetDeletedDataLakes.mockReset();
  useGetDeletedDataLakes.mockReturnValue({ data: undefined });
  useActiveDataLakeBatches.mockReset();
  useActiveDataLakeBatches.mockReturnValue({ data: [] });
  useGetArchivedDataLakes.mockReset();
  useGetArchivedDataLakes.mockReturnValue({ data: undefined });
  useGetDeletedDataLakes.mockReset();
  useGetDeletedDataLakes.mockReturnValue({ data: undefined });
  // managerTab is module state in the real store, so a test left in Discover would otherwise
  // decide what the next one renders.
  useDataLakeWizardStore.setState({ managerTab: 'mine' });
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
    // 3, not the 0 its `lk:` prefix count reports: the chip sizes the lake by membership, so
    // files that carry only the lake meta-tag are still counted.
    expect(screen.getByTestId('datalake-manager-lake-mine')).toHaveTextContent('3');
    // 2, not the 9 tag occurrences under `th:` - a multi-tagged file counts once.
    expect(screen.getByTestId('datalake-manager-lake-theirs')).toHaveTextContent('2');
    // Sidebar accordions: lakes + the lifecycle sections; right pane shows the hint,
    // footer keeps Create.
    expect(screen.getByTestId('datalake-manager-lakes-section')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-archived-section')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-deleted-section')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-overview')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-create-btn')).toBeInTheDocument();
  });

  it('states an empty lifecycle section on its header instead of offering an accordion', async () => {
    const user = userEvent.setup();
    useGetArchivedDataLakes.mockReturnValue({ data: [] });
    useGetDeletedDataLakes.mockReturnValue({ data: [] });
    renderPanel();

    const archived = screen.getByTestId('datalake-archived-section-toggle');
    expect(archived).toHaveTextContent('Archived');
    expect(archived).toHaveTextContent('No files');
    expect(screen.getByTestId('datalake-deleted-section-toggle')).toHaveTextContent('No files');
    // Not a control: nothing to expand, so no button semantics and no chevron.
    expect(archived).not.toHaveAttribute('role', 'button');

    // Clicking it does nothing rather than toggling an empty body open.
    await user.click(archived);
    expect(archived).toHaveTextContent('No files');
  });

  it('opens the public Discover catalog from the footer and returns to it via the store tab', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('datalake-manager-discover-btn'));
    expect(screen.getByTestId('mock-discover')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-manager-overview')).not.toBeInTheDocument();
    // Opening one of your own lakes leaves the catalog...
    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    expect(screen.queryByTestId('mock-discover')).not.toBeInTheDocument();
    // ...so backing out lands on the overview, not back in Discover.
    await user.click(screen.getByTestId('datalake-manager-back'));
    expect(screen.getByTestId('datalake-manager-overview')).toBeInTheDocument();
  });

  it('exits the open lake when Discover is clicked, rather than arming the tab invisibly', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    expect(screen.queryByTestId('datalake-manager-overview')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('datalake-manager-discover-btn'));
    // The catalog shows on THIS click: the activeLake branch used to outrank the tab and swallow it.
    expect(screen.getByTestId('mock-discover')).toBeInTheDocument();
    // The lake is really closed, so no in-lake Back row survives into the catalog.
    expect(screen.queryByTestId('datalake-manager-back')).not.toBeInTheDocument();
  });

  it('reads as a plain destination, never as a pressed mode', async () => {
    const user = userEvent.setup();
    renderPanel();
    const discover = screen.getByTestId('datalake-manager-discover-btn');
    expect(discover).not.toHaveAttribute('aria-pressed');

    await user.click(discover);

    expect(screen.getByTestId('mock-discover')).toBeInTheDocument();
    // Same button, same look: it navigated rather than latching a mode on.
    expect(discover).not.toHaveAttribute('aria-pressed');
    expect(discover.className).toMatch(/MuiButton-variantOutlined/);
  });

  it('leaves the catalog by opening one of your own lakes', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('datalake-manager-discover-btn'));
    expect(screen.getByTestId('mock-discover')).toBeInTheDocument();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));

    expect(screen.queryByTestId('mock-discover')).not.toBeInTheDocument();
  });

  it('collapses the Data Lakes accordion, hiding the lake rows', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('datalake-manager-lakes-section-toggle'));
    expect(screen.queryByTestId('datalake-manager-lake-mine')).not.toBeInTheDocument();
    // The lifecycle accordions are unaffected.
    expect(screen.getByTestId('datalake-archived-section')).toBeInTheDocument();
  });

  // A-Z names itself with the alphabet glyph, so the mode is readable from the button and not
  // only from the tooltip; count keeps the neutral swap glyph.
  it('swaps the sort icon to the alphabet glyph when toggled to A-Z', async () => {
    const user = userEvent.setup();
    renderPanel();
    const toggle = screen.getByTestId('datalake-manager-sort-toggle');
    expect(toggle).toHaveAttribute('data-sort', 'count');
    expect(screen.getByTestId('SwapVertIcon')).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('data-sort', 'alpha');
    expect(screen.getByTestId('SortByAlphaIcon')).toBeInTheDocument();
    expect(screen.queryByTestId('SwapVertIcon')).not.toBeInTheDocument();
  });

  it('shows a persistent info icon next to the Data Lakes header that reveals the RAG explanation on hover', async () => {
    const user = userEvent.setup();
    renderPanel();

    // Always present next to the header - not a one-time dismissable callout.
    const trigger = screen.getByTestId('field-tooltip-data-lake-panel');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-label', 'Help: Data Lakes');

    await user.hover(trigger);
    expect(
      await screen.findByText(/curated knowledge base the AI grounds its answers in \(RAG\)/i)
    ).toBeInTheDocument();
  });

  it('clicking the info icon does not also collapse the Data Lakes accordion', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('field-tooltip-data-lake-panel'));
    expect(screen.getByTestId('datalake-manager-lake-mine')).toBeInTheDocument();
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

  it('lists a category-tagged file alongside its own subfolders, not just inside them', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    await user.click(screen.getByTestId('datalake-manager-node-genre'));

    // war/peace are genre's children; f5 is tagged "lk:genre" itself - all three must be
    // reachable from this one folder, or f5 has no path to it anywhere in the tree.
    expect(screen.getByTestId('datalake-manager-node-war')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-node-peace')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-file-f5')).toHaveTextContent('genre-overview');

    // Selecting it opens the file directly - no extra navigation hop.
    await user.click(screen.getByTestId('datalake-manager-file-f5'));
    expect(screen.getByTestId('mock-article')).toHaveTextContent('genre-overview.md');
  });

  it('sorts bracket-prefixed file names by category then title, not the raw leading "["', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    await user.click(screen.getByTestId('datalake-manager-node-briefs'));
    await user.click(screen.getByTestId('datalake-manager-node-x'));

    // Marketing group (Apple before Zebra within it) sorts before Sales - a raw-name sort would
    // instead tiebreak on the shared "[" and give a different, meaningless order.
    const fileRows = screen.getAllByTestId(/^datalake-manager-file-/).map(el => el.getAttribute('data-testid'));
    expect(fileRows).toEqual(['datalake-manager-file-f7', 'datalake-manager-file-f6', 'datalake-manager-file-f8']);
  });

  it('opens the Uncategorized bucket and lists the untagged file', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    await user.click(screen.getByTestId('datalake-manager-uncategorized'));

    // The synthetic bucket is a leaf: f3 (tagged only datalake:mine) must be reachable here.
    expect(screen.getByTestId('datalake-manager-file-f3')).toHaveTextContent('loose');
    expect(screen.queryByTestId('datalake-manager-file-f1')).not.toBeInTheDocument();
    // f4 carries `lk:` and nothing else under the prefix. A `startsWith`-only check counts that
    // as categorized and drops it from the bucket, which is the drift this shares the server's
    // predicate to avoid.
    expect(screen.getByTestId('datalake-manager-file-f4')).toHaveTextContent('bare');
  });

  it('clears the search when entering a lake, so a root query cannot filter its categories', async () => {
    const user = userEvent.setup();
    renderPanel();

    // Type a lake-name query at root, then open the match.
    await user.type(screen.getByTestId('datalake-manager-search').querySelector('input')!, 'Mine');
    await user.click(screen.getByTestId('datalake-manager-lake-mine'));

    // Search reset -> the lake's categories show (a stale 'Mine' query would hide them all).
    expect(screen.getByTestId('datalake-manager-search').querySelector('input')).toHaveValue('');
    expect(screen.getByTestId('datalake-manager-node-genre')).toBeInTheDocument();
  });

  it('falls back to the root overview when the active lake vanishes from the list', () => {
    // Deriving activeLake from the live list (no effect) means an archived/deleted lake that
    // leaves the list drops the panel back to root on its own.
    const { rerender } = renderPanel();
    fireEvent.click(screen.getByTestId('datalake-manager-lake-mine'));
    expect(screen.getByTestId('datalake-manager-lakeinfo')).toBeInTheDocument();

    useGetDataLakes.mockReturnValue({ data: [theirsLake], isLoading: false });
    rerender(
      <Wrapper>
        <DataLakeManagerPanel />
      </Wrapper>
    );
    expect(screen.queryByTestId('datalake-manager-lakeinfo')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-overview')).toBeInTheDocument();
  });
});

describe('DataLakeManagerPanel - management affordances gate on canManage', () => {
  it('shows Add files / Settings / Archive / Delete on a lake the caller can manage', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));

    expect(screen.getByTestId('datalake-addfiles-btn-mine')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-settings-btn-mine')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-archive-btn-mine')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-delete-active-btn-mine')).toBeInTheDocument();
  });

  it("hides all four on a lake the caller cannot manage (someone else's public lake)", async () => {
    const user = userEvent.setup();
    renderPanel();

    // The read-only lake still opens - only the management affordances are gated.
    await user.click(screen.getByTestId('datalake-manager-lake-theirs'));

    expect(screen.getByTestId('datalake-manager-lakeinfo')).toHaveTextContent('Theirs');
    expect(screen.queryByTestId('datalake-addfiles-btn-theirs')).toBeNull();
    expect(screen.queryByTestId('datalake-settings-btn-theirs')).toBeNull();
    expect(screen.queryByTestId('datalake-archive-btn-theirs')).toBeNull();
    expect(screen.queryByTestId('datalake-delete-active-btn-theirs')).toBeNull();
  });

  it('archiving the active lake exits to the root overview (no re-entry on a later restore)', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    await user.click(screen.getByTestId('datalake-archive-btn-mine'));

    // The archive's onSuccess clears the active lake, so even though the mocked list still
    // contains 'mine', the panel is back at root - a restore later can't teleport back in.
    expect(archiveMutate).toHaveBeenCalledWith('mine', expect.objectContaining({ onSuccess: expect.any(Function) }));
    expect(screen.queryByTestId('datalake-manager-lakeinfo')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-overview')).toBeInTheDocument();
  });

  it('deleting the active lake directly (skipping archive) exits to the root overview', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    await user.click(screen.getByTestId('datalake-delete-active-btn-mine'));

    // Same lifecycle action the archived row's Delete button calls - deleteDataLake has no
    // archived-status precondition, so this reaches the same recoverable soft-delete.
    expect(deleteMutate).toHaveBeenCalledWith('mine', expect.objectContaining({ onSuccess: expect.any(Function) }));
    expect(screen.queryByTestId('datalake-manager-lakeinfo')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-overview')).toBeInTheDocument();
  });

  it('opens the settings editor for the selected lake', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    await user.click(screen.getByTestId('datalake-settings-btn-mine'));

    expect(screen.getByTestId('mock-settings')).toHaveTextContent('Mine');
  });

  it("flags a lake the caller does not own with the creator's name, so it can't be mistaken for their own", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-theirs'));

    const chip = screen.getByTestId('datalake-manager-owner-chip-theirs');
    expect(chip).toHaveTextContent('Owner: Ada Owner');
  });

  it("shows no owner marker on the caller's own lake", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));

    expect(screen.queryByTestId('datalake-manager-owner-chip-mine')).toBeNull();
  });

  it('marks not-own lakes in the sidebar list itself, but not own ones (no need to open each)', () => {
    renderPanel();

    // The confusion the issue reports starts in the list ("both appeared in the admin's My
    // lakes tab"), so the owner cue must live on the row, before anything is opened.
    expect(screen.getByTestId('datalake-manager-owner-icon-theirs')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-manager-owner-icon-mine')).toBeNull();
  });

  it('keeps the owner chip AND the management buttons on an admin-managed lake owned by someone else', async () => {
    // The case the feature exists for: a global admin on another tenant's lake, where canManage
    // is true (Add files / Settings / Archive are live) AND isOwn is false. The marker must
    // coexist with the controls - a chip that vanished whenever canManage held would leave
    // exactly the QA scenario unmarked, and nothing here would fail.
    const adminView = {
      ...theirsLake,
      id: 'adminview',
      name: 'Admin View',
      slug: 'adminview',
      datalakeTag: 'datalake:adminview',
      canManage: true,
      isOwn: false,
      ownerDisplayName: 'Ada Owner',
    };
    useGetDataLakes.mockReturnValue({ data: [adminView], isLoading: false });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-adminview'));

    expect(screen.getByTestId('datalake-manager-owner-chip-adminview')).toHaveTextContent('Owner: Ada Owner');
    expect(screen.getByTestId('datalake-addfiles-btn-adminview')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-settings-btn-adminview')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-archive-btn-adminview')).toBeInTheDocument();
  });
});

/**
 * canRebuild is NARROWER than canManage: a fallback (built-in) lake has no document to manage
 * (canManage always false) but CAN still be rebuilt by an admin (assertLakeRebuildAccess gates on
 * ctx.isAdmin directly). The Rebuild button must render off canRebuild - and, since it used to sit
 * inside the same fragment as Add files/Settings/Archive, this also pins that it was extracted
 * from that fragment rather than the fragment's gate being flipped (which would light up all four).
 */
describe('DataLakeManagerPanel - canRebuild is narrower than canManage (fallback lakes)', () => {
  it('shows Rebuild passages but NOT Add files/Settings/Archive on a fallback lake as admin', async () => {
    useGetDataLakes.mockReturnValue({ data: [fallbackLakeAsAdmin], isLoading: false });
    useUnderChunkedCount.mockReturnValue({ data: { underChunkedCount: 5, failedCount: 0 } });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-opti-knowledge'));

    expect(screen.getByTestId('datalake-rebuild-passages-btn-opti-knowledge')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-rebuild-chip-opti-knowledge')).toHaveTextContent('5 to rebuild');
    expect(screen.queryByTestId('datalake-addfiles-btn-opti-knowledge')).toBeNull();
    expect(screen.queryByTestId('datalake-settings-btn-opti-knowledge')).toBeNull();
    expect(screen.queryByTestId('datalake-archive-btn-opti-knowledge')).toBeNull();
    expect(screen.queryByTestId('datalake-delete-active-btn-opti-knowledge')).toBeNull();
    // fallbackLakeAsAdmin has canManage: false, canRebuild: true - asserting the SECOND arg
    // catches a revert to `lake.canManage` at the call site, which the render assertions above
    // cannot: the mock's canned return value doesn't depend on what it was called with, so only
    // this direct check on the call args would fail if the enable flag reverted.
    expect(useUnderChunkedCount).toHaveBeenCalledWith('opti-knowledge', true);
  });

  it('shows the "N failed" chip for a canRebuild-only actor (fallback lake), not just canManage', async () => {
    // Phase 4's definition of done needs failedCount visible to the actor doing the rebuild - a
    // fallback-lake admin can rebuild but never canManage, so gating the chip on canManage alone
    // would make "0 failed" unverifiable for the only actor who can act on it.
    useGetDataLakes.mockReturnValue({ data: [fallbackLakeAsAdmin], isLoading: false });
    useUnderChunkedCount.mockReturnValue({ data: { underChunkedCount: 0, failedCount: 2 } });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-opti-knowledge'));

    expect(screen.getByTestId('datalake-manager-rebuild-failed-chip-opti-knowledge')).toHaveTextContent('2 failed');
  });

  it('hides Rebuild passages on a lake the caller cannot rebuild, even with a backlog', async () => {
    // theirsLake: canManage false, canRebuild false (a stranger's public lake).
    useUnderChunkedCount.mockReturnValue({ data: { underChunkedCount: 5, failedCount: 0 } });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-theirs'));

    expect(screen.queryByTestId('datalake-rebuild-passages-btn-theirs')).toBeNull();
    expect(screen.queryByTestId('datalake-manager-rebuild-chip-theirs')).toBeNull();
  });

  it('shows Rebuild passages on a DB lake the caller manages (canRebuild === canManage)', async () => {
    useUnderChunkedCount.mockReturnValue({ data: { underChunkedCount: 3, failedCount: 0 } });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));

    expect(screen.getByTestId('datalake-rebuild-passages-btn-mine')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-addfiles-btn-mine')).toBeInTheDocument();
  });
});

/**
 * The taxonomy-status UI (queued/analyzing/ready/failed chips + review panel) used to live only
 * in the orphaned DataLakeListPanel - this is the port of that functionality into the panel
 * that's actually reachable in the app.
 */
describe('DataLakeManagerPanel - background AI-tag suggestion status', () => {
  const batch = (overrides: Record<string, unknown> = {}) => ({
    id: 'b1',
    dataLakeId: 'mine',
    taxonomyStatus: 'ready',
    ...overrides,
  });

  it('shows no taxonomy indicator anywhere when no batch needs attention', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.queryByTestId('datalake-manager-taxonomy-progress-mine')).toBeNull();
    expect(screen.queryByTestId('datalake-manager-taxonomy-review-mine')).toBeNull();
    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    expect(screen.queryByTestId('datalake-manager-taxonomy-review-chip-mine')).toBeNull();
  });

  it('shows the in-progress indicator in the sidebar and the right pane while queued/analyzing', async () => {
    useActiveDataLakeBatches.mockReturnValue({ data: [batch({ taxonomyStatus: 'analyzing' })] });
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByTestId('datalake-manager-taxonomy-progress-mine')).toBeInTheDocument();
    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    expect(screen.getByTestId('datalake-manager-taxonomy-progress-chip-mine')).toHaveTextContent('AI tagging');
  });

  it('opens the review panel with the right batch and prefix from the sidebar indicator', async () => {
    useActiveDataLakeBatches.mockReturnValue({ data: [batch()] });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-taxonomy-review-mine'));

    const panel = screen.getByTestId('mock-taxonomy-review-panel');
    expect(panel).toHaveAttribute('data-batch-id', 'b1');
    expect(panel).toHaveAttribute('data-prefix', 'lk');
    // Clicking the indicator must not also navigate into the lake (stopPropagation).
    expect(screen.queryByTestId('datalake-manager-lakeinfo')).not.toBeInTheDocument();
  });

  // This is the actual regression: before this fix, `reviewingBatch` was a frozen snapshot
  // taken at click time, so a re-analyze completing (the query refetching with fresh
  // taxonomyStatus/taxonomySuggestions) never reached the open panel.
  it('flows a batches-list refetch into the still-open panel instead of showing a frozen snapshot', async () => {
    useActiveDataLakeBatches.mockReturnValue({ data: [batch()] });
    const user = userEvent.setup();
    const { rerender } = renderPanel();

    await user.click(screen.getByTestId('datalake-manager-taxonomy-review-mine'));
    expect(screen.getByTestId('mock-taxonomy-review-panel')).toHaveAttribute('data-batch-status', 'ready');

    // Simulate the poll refetching mid-review with a re-analyze in flight, then completing.
    useActiveDataLakeBatches.mockReturnValue({ data: [batch({ taxonomyStatus: 'analyzing' })] });
    rerenderPanel(rerender);
    expect(screen.getByTestId('mock-taxonomy-review-panel')).toHaveAttribute('data-batch-status', 'analyzing');

    useActiveDataLakeBatches.mockReturnValue({ data: [batch({ taxonomyStatus: 'ready' })] });
    rerenderPanel(rerender);
    // Still open (same batch id), now reflecting the fresh suggestions - not stuck on
    // the object captured when the indicator was first clicked.
    const panel = screen.getByTestId('mock-taxonomy-review-panel');
    expect(panel).toHaveAttribute('data-batch-id', 'b1');
    expect(panel).toHaveAttribute('data-batch-status', 'ready');
  });

  it('closes the panel once the batch drops out of the attention set (e.g. after apply completes)', async () => {
    useActiveDataLakeBatches.mockReturnValue({ data: [batch()] });
    const user = userEvent.setup();
    const { rerender } = renderPanel();

    await user.click(screen.getByTestId('datalake-manager-taxonomy-review-mine'));
    expect(screen.getByTestId('mock-taxonomy-review-panel')).toBeInTheDocument();

    // 'applied' isn't in the attention set, so the batch disappears from the list response.
    useActiveDataLakeBatches.mockReturnValue({ data: [] });
    rerenderPanel(rerender);

    expect(screen.queryByTestId('mock-taxonomy-review-panel')).not.toBeInTheDocument();
  });

  it('opens the review panel from the right-pane chip too, and closes it', async () => {
    useActiveDataLakeBatches.mockReturnValue({ data: [batch()] });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-lake-mine'));
    await user.click(within(screen.getByTestId('datalake-manager-taxonomy-review-chip-mine')).getByRole('button'));
    expect(screen.getByTestId('mock-taxonomy-review-panel')).toBeInTheDocument();

    await user.click(screen.getByTestId('mock-taxonomy-review-close'));
    expect(screen.queryByTestId('mock-taxonomy-review-panel')).not.toBeInTheDocument();
  });

  it('shows a failed indicator that also opens the review panel', async () => {
    useActiveDataLakeBatches.mockReturnValue({ data: [batch({ taxonomyStatus: 'failed' })] });
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByTestId('datalake-manager-taxonomy-failed-mine')).toBeInTheDocument();
    await user.click(screen.getByTestId('datalake-manager-taxonomy-failed-mine'));
    expect(screen.getByTestId('mock-taxonomy-review-panel')).toHaveAttribute('data-batch-id', 'b1');
  });

  it('prefers the taxonomy-attention batch when a lake has more than one active batch', async () => {
    // An ingest-only batch (taxonomyStatus 'none') alongside the one actually awaiting review -
    // the attention-worthy one must win, not whichever happens to come first in the list.
    useActiveDataLakeBatches.mockReturnValue({
      data: [batch({ id: 'ingest-only', taxonomyStatus: 'none' }), batch({ id: 'b1', taxonomyStatus: 'ready' })],
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-manager-taxonomy-review-mine'));
    expect(screen.getByTestId('mock-taxonomy-review-panel')).toHaveAttribute('data-batch-id', 'b1');
  });
});

describe('DataLakeManagerPanel - purge confirmation', () => {
  const deletedLake = { id: 'gone', name: 'Gone', fileTagPrefix: 'gn' };

  it('purges the confirmed lake by id and closes the dialog', async () => {
    useGetDeletedDataLakes.mockReturnValue({ data: [deletedLake] });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-deleted-section-toggle'));
    expect(screen.getByTestId('datalake-deleted-section-card-gone')).toBeInTheDocument();

    // Lifecycle row actions moved behind a RowActionsMenu trigger on main; open it before the item.
    await user.click(screen.getByTestId('datalake-deleted-section-menu-btn-gone'));
    await user.click(screen.getByTestId('datalake-purge-btn-gone'));
    expect(screen.getByTestId('datalake-purge-confirm')).toBeInTheDocument();
    await user.click(screen.getByTestId('datalake-purge-confirm-btn'));

    // The lake id is this panel's whole contract with useCleanupDataLake: the purge answers
    // 202-queued, so that hook clears the row by filtering the deleted-list cache on exactly
    // this argument rather than refetching (see dataLakes.test.ts).
    expect(cleanupMutate).toHaveBeenCalledWith('gone', expect.objectContaining({ onSuccess: expect.any(Function) }));
    await waitFor(() => expect(screen.queryByTestId('datalake-purge-confirm')).not.toBeInTheDocument());
  });
});
