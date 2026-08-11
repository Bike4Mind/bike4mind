import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import DataLakeManagerPanel from './DataLakeManagerPanel';

// Archive resolves synchronously so the onSuccess (exit-to-root) wiring is exercised.
const archiveMutate = vi.fn((_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
const useActiveDataLakeBatches = vi.fn(() => ({ data: [] as unknown[] }));
vi.mock('@client/app/hooks/data/dataLakes', () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useArchiveDataLake: () => ({ mutate: archiveMutate, isPending: false }),
    useUnarchiveDataLake: mutation,
    useRestoreDeletedDataLake: mutation,
    usePermanentDeleteDataLake: mutation,
    useCleanupDataLake: mutation,
    useGetArchivedDataLakes: () => ({ data: undefined }),
    useGetDeletedDataLakes: () => ({ data: undefined }),
    useActiveDataLakeBatches: () => useActiveDataLakeBatches(),
    useGetDataLakes: () => useGetDataLakes(),
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
];

const useGetDataLakes = vi.fn(() => ({ data: [] as unknown[], isLoading: false }));

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
  isOwn: false,
  ownerDisplayName: 'Ada Owner',
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
  archiveMutate.mockClear();
  useActiveDataLakeBatches.mockReset();
  useActiveDataLakeBatches.mockReturnValue({ data: [] });
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
    // The lake is really closed, so a later Back cannot drop the user into Discover by surprise.
    expect(screen.queryByTestId('datalake-manager-back')).not.toBeInTheDocument();
  });

  it('toggles back out of Discover - the one exit that needs no lake of your own to click', async () => {
    const user = userEvent.setup();
    // No lakes: selectLake, the only other route back to the overview, has no row to click.
    useGetDataLakes.mockReturnValue({ data: [], isLoading: false });
    renderPanel();
    const discover = screen.getByTestId('datalake-manager-discover-btn');
    expect(discover).toHaveAttribute('aria-pressed', 'false');

    await user.click(discover);
    expect(screen.getByTestId('mock-discover')).toBeInTheDocument();
    expect(discover).toHaveAttribute('aria-pressed', 'true');

    await user.click(discover);
    expect(screen.queryByTestId('mock-discover')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-manager-overview')).toBeInTheDocument();
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
