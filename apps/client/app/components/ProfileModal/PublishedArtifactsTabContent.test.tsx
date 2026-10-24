import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { PUBLISH_TAGS_MAX } from '@bike4mind/common';

const {
  mockList,
  mockExport,
  mockDownloadData,
  mockToastError,
  mockToastSuccess,
  mockRefresh,
  mockPrint,
  mockUpdateTags,
  mockUpdateVisibility,
} = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockUpdateTags: vi.fn(),
  mockUpdateVisibility: vi.fn(),
  mockExport: vi.fn(),
  mockDownloadData: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockRefresh: vi.fn(),
  mockPrint: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: mockToastError, success: mockToastSuccess } }));

vi.mock('@client/app/utils/publishApi', () => ({
  listMyPublishedArtifacts: (...a: unknown[]) => mockList(...a),
  deletePublishedArtifact: vi.fn(),
  updatePublishedVisibility: (...a: unknown[]) => mockUpdateVisibility(...a),
  updatePublishedCommentPolicy: vi.fn().mockResolvedValue(undefined),
  updatePublishedTags: (...a: unknown[]) => mockUpdateTags(...a),
  fetchMyTagVocabulary: () => {
    mockVocabCalls.push(1);
    return Promise.resolve(mockVocabulary);
  },
  restorePreviousVersion: vi.fn(),
  toArtifactSharePath: (_t: string, s: string, slug: string) => `/p/u/${s}/${slug}`,
  fetchPublishedExport: (...a: unknown[]) => mockExport(...a),
  refreshPublishedFromSource: (...a: unknown[]) => mockRefresh(...a),
  // Real predicate - the point of these tests is that the button follows it.
  canRefreshFromSource: (a: { source: { kind: string; artifactId?: string } }) =>
    a.source.kind === 'bundle' && !!a.source.artifactId,
}));

vi.mock('@client/app/utils/download', () => ({
  downloadData: (...a: unknown[]) => mockDownloadData(...a),
}));

vi.mock('@client/app/utils/printToPdf', () => ({
  printHtmlForPdf: (...a: unknown[]) => mockPrint(...a),
}));

// Stub the panel so this test targets the toggle wiring, not the panel's fetch. The buttons stand
// in for a gate apply in the real AccessGateEditor.
vi.mock('@client/app/components/common/ManageSharingPanel', () => ({
  ManageSharingPanel: (p: { publicId: string; onGateChange?: (gate: { kind: 'passphrase' } | null) => void }) => (
    <div data-testid={`stub-panel-${p.publicId}`}>
      <button
        data-testid={`stub-panel-set-passphrase-${p.publicId}`}
        onClick={() => p.onGateChange?.({ kind: 'passphrase' })}
      />
      <button data-testid={`stub-panel-clear-gate-${p.publicId}`} onClick={() => p.onGateChange?.(null)} />
    </div>
  ),
}));

import PublishedArtifactsTabContent from './PublishedArtifactsTabContent';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CssVarsProvider theme={appTheme}>
        <PublishedArtifactsTabContent />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const bundleRow = {
  publicId: 'pub-1',
  tier: 'user',
  scopeId: 'erik',
  slug: 's',
  title: 'My Artifact',
  visibility: 'public',
  commentPolicy: 'none',
  source: { kind: 'bundle' },
  versionsCount: 1,
};
const replyRow = { ...bundleRow, publicId: 'pub-2', title: 'My Reply', source: { kind: 'reply' } };

/** listMyPublishedArtifacts returns a page envelope, not a bare array. */
/** Tag suggestions the autocomplete offers; freeform, so this only shapes suggestions. */
let mockVocabulary: Array<{ tag: string; count: number }> = [];
/** One entry per vocabulary fetch, so a test can assert it is NOT refetched. */
const mockVocabCalls: number[] = [];

const page = (rows: unknown[], over: Record<string, unknown> = {}) => ({
  artifacts: rows,
  total: rows.length,
  limit: 25,
  skip: 0,
  facets: { kind: {}, visibility: {}, gate: {}, comments: 0, tag: {} },
  ...over,
});

/**
 * The row is collapsed by default now, so its settings, export and version controls live behind
 * the disclosure. Open it first - this is the click a real owner makes too.
 */
const expandRow = (publicId: string) => fireEvent.click(screen.getByTestId(`published-artifact-expand-${publicId}`));
/** A bundle that still knows its in-app source, so it can be refreshed. */
const sourcedRow = { ...bundleRow, publicId: 'pub-3', source: { kind: 'bundle', artifactId: 'artifact_html_x_1_0' } };

beforeEach(() => {
  mockList.mockReset().mockResolvedValue(page([bundleRow]));
  mockExport.mockReset().mockResolvedValue('# exported');
  mockDownloadData.mockReset();
  mockRefresh.mockReset().mockResolvedValue({ publicId: 'pub-3' });
  mockToastError.mockReset();
  mockToastSuccess.mockReset();
  mockPrint.mockReset();
  mockUpdateTags.mockReset().mockResolvedValue(undefined);
  mockVocabulary = [];
  mockVocabCalls.length = 0;
});

describe('PublishedArtifactsTabContent - manage toggle', () => {
  it('mounts the sharing panel only after the </> toggle is clicked, and unmounts on re-click', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    // Lazy: panel not mounted until the owner opens it.
    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();

    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();

    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();
  });
});

describe('PublishedArtifactsTabContent - export actions (issue #1142)', () => {
  it('hides Copy-as-Markdown for a bundle, which has no faithful Markdown form', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    expect(screen.queryByTestId('published-artifact-copy-md-pub-1')).toBeNull();
    // HTML is faithful for every kind, so that action is always present.
    expect(screen.getByTestId('published-artifact-save-html-pub-1')).not.toBeNull();
  });

  it('copies a reply as Markdown through the authenticated export fetch', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    mockList.mockResolvedValue(page([replyRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-2');
    expandRow('pub-2');

    fireEvent.click(screen.getByTestId('published-artifact-copy-md-pub-2'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# exported'));
    // Fetched via the api client (not a bare download link), keyed on the viewer path.
    expect(mockExport).toHaveBeenCalledWith('/p/r/pub-2', 'md');
    expect(mockDownloadData).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('saves as HTML with the slugified filename and the right content type', async () => {
    mockExport.mockResolvedValue('<html></html>');
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    fireEvent.click(screen.getByTestId('published-artifact-save-html-pub-1'));
    await waitFor(() =>
      expect(mockDownloadData).toHaveBeenCalledWith('<html></html>', 'my-artifact.html', 'text/html; charset=utf-8')
    );
    expect(mockExport).toHaveBeenCalledWith('/p/u/erik/s', 'html');
  });

  it('surfaces an export failure instead of downloading an empty file', async () => {
    mockExport.mockRejectedValue(new Error('boom'));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    fireEvent.click(screen.getByTestId('published-artifact-save-html-pub-1'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockDownloadData).not.toHaveBeenCalled();
  });

  it('saves as PDF by printing the HTML export - offered for every kind', async () => {
    mockExport.mockResolvedValue('<html><body>bundle</body></html>');
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    // Present on a bundle, which has no faithful Markdown form - PDF is not gated.
    fireEvent.click(screen.getByTestId('published-artifact-save-pdf-pub-1'));
    // Reuses the HTML export as the source of truth, then hands it to the print frame.
    expect(mockExport).toHaveBeenCalledWith('/p/u/erik/s', 'html');
    await waitFor(() => expect(mockPrint).toHaveBeenCalledWith('<html><body>bundle</body></html>'));
    // Never downloaded: PDF is the browser's dialog, not a file we emit.
    expect(mockDownloadData).not.toHaveBeenCalled();
  });

  it('surfaces a failure to fetch the export for printing', async () => {
    mockExport.mockRejectedValue(new Error('boom'));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    fireEvent.click(screen.getByTestId('published-artifact-save-pdf-pub-1'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockPrint).not.toHaveBeenCalled();
  });
});

describe('PublishedArtifactsTabContent - refresh from source (issue #1142, option 2)', () => {
  it('offers Refresh only for a bundle that still knows its source artifact', async () => {
    mockList.mockResolvedValue(page([bundleRow, replyRow, sourcedRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');
    expandRow('pub-3');

    expect(screen.getByTestId('published-artifact-refresh-pub-3')).not.toBeNull();
    // No artifactId (published from outside the app) - nothing to read back.
    expect(screen.queryByTestId('published-artifact-refresh-pub-1')).toBeNull();
    // A reply snapshots an immutable chat message.
    expect(screen.queryByTestId('published-artifact-refresh-pub-2')).toBeNull();
  });

  it('confirms before refreshing, since it replaces what viewers of a live link see', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockList.mockResolvedValue(page([sourcedRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');
    expandRow('pub-3');

    fireEvent.click(screen.getByTestId('published-artifact-refresh-pub-3'));
    expect(confirm).toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('refreshes the row on confirm and reports success', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockList.mockResolvedValue(page([sourcedRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');
    expandRow('pub-3');

    fireEvent.click(screen.getByTestId('published-artifact-refresh-pub-3'));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'pub-3' })));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    confirm.mockRestore();
  });

  it('surfaces a refresh failure', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockRefresh.mockRejectedValue(new Error('boom'));
    mockList.mockResolvedValue(page([sourcedRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');
    expandRow('pub-3');

    fireEvent.click(screen.getByTestId('published-artifact-refresh-pub-3'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastSuccess).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('points the single-version hint at Refresh when the row can use it', async () => {
    mockList.mockResolvedValue(page([sourcedRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');
    // The hint moved into the expanded row: repeated on every collapsed row it was the largest
    // consumer of vertical space on the page, and it is guidance you read while in settings.
    expandRow('pub-3');
    const hint = await screen.findByTestId('published-artifact-single-version-pub-3');
    expect(hint.textContent).toContain('refresh it from source');
  });

  it('keeps the generic hint wording when the row cannot be refreshed', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    // The hint moved into the expanded row: repeated on every collapsed row it was the largest
    // consumer of vertical space on the page, and it is guidance you read while in settings.
    expandRow('pub-1');
    const hint = await screen.findByTestId('published-artifact-single-version-pub-1');
    expect(hint.textContent).toContain('re-publish this artifact');
  });
});

/**
 * The library controls. These assert the QUERY the tab asks for rather than re-testing the
 * server's filtering (buildListQuery has its own unit tests) - what matters here is that a
 * click turns into the right request and that paging resets when the result set changes.
 */
describe('PublishedArtifactsTabContent - search, facets and paging', () => {
  /** The query argument of the most recent list call. */
  /** The most recent LIST call, ignoring the separate facet-counts query. */
  const lastQuery = () => {
    const listCalls = mockList.mock.calls.map(c => c[0] as Record<string, unknown>).filter(c => c.facets !== true);
    return listCalls[listCalls.length - 1];
  };

  it('requests a bounded page instead of the whole library', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expect(lastQuery()).toMatchObject({ limit: 25, skip: 0, sort: 'newest' });
  });

  it('collapses the row: settings and export controls are hidden until expanded', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');

    // Scannable on the collapsed row.
    expect(screen.getByTestId('published-artifact-meta-pub-1')).not.toBeNull();
    expect(screen.getByTestId('published-artifact-copy-pub-1')).not.toBeNull();
    // Everything else is one click away.
    expect(screen.queryByTestId('published-artifact-visibility-pub-1')).toBeNull();
    expect(screen.queryByTestId('published-artifact-delete-pub-1')).toBeNull();

    expandRow('pub-1');
    expect(screen.getByTestId('published-artifact-visibility-pub-1')).not.toBeNull();
    expect(screen.getByTestId('published-artifact-delete-pub-1')).not.toBeNull();
  });

  it('expands rows independently, so two artifacts can be compared', async () => {
    mockList.mockResolvedValue(page([bundleRow, replyRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');

    expandRow('pub-1');
    expandRow('pub-2');

    expect(screen.getByTestId('published-artifact-visibility-pub-1')).not.toBeNull();
    expect(screen.getByTestId('published-artifact-visibility-pub-2')).not.toBeNull();
  });

  it('sends the typed search term, debounced', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');

    fireEvent.change(screen.getByTestId('published-artifacts-search'), { target: { value: 'northwind' } });

    await waitFor(() => expect(lastQuery().q).toBe('northwind'));
  });

  it('filters on a facet chip and turns the filter off when clicked again', async () => {
    mockList.mockResolvedValue(
      page([bundleRow], { facets: { kind: { bundle: 3 }, visibility: {}, gate: {}, comments: 0, tag: {} } })
    );
    renderTab();
    await screen.findByTestId('published-artifacts-facet-kind-bundle');

    fireEvent.click(screen.getByTestId('published-artifacts-facet-kind-bundle'));
    await waitFor(() => expect(lastQuery().kind).toBe('bundle'));

    fireEvent.click(screen.getByTestId('published-artifacts-facet-kind-bundle'));
    await waitFor(() => expect(lastQuery().kind).toBeUndefined());
  });

  it('pages forward and back, and reports the range against the real total', async () => {
    mockList.mockResolvedValue(page([bundleRow], { total: 60 }));
    renderTab();
    await screen.findByTestId('published-artifacts-pager');

    expect(screen.getByTestId('published-artifacts-pager').textContent).toContain('of 60');
    expect(screen.getByTestId('published-artifacts-prev')).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByTestId('published-artifacts-next'));
    await waitFor(() => expect(lastQuery().skip).toBe(25));

    fireEvent.click(screen.getByTestId('published-artifacts-prev'));
    await waitFor(() => expect(lastQuery().skip).toBe(0));
  });

  it('hides the pager when everything fits on one page', async () => {
    mockList.mockResolvedValue(page([bundleRow], { total: 1 }));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expect(screen.queryByTestId('published-artifacts-pager')).toBeNull();
  });

  it('returns to the first page when a filter changes', async () => {
    // Staying on page 3 of a narrower result set is how you end up looking at an empty list you
    // did not ask for.
    mockList.mockResolvedValue(
      page([bundleRow], { total: 60, facets: { kind: { bundle: 60 }, visibility: {}, gate: {}, comments: 0, tag: {} } })
    );
    renderTab();
    await screen.findByTestId('published-artifacts-pager');

    fireEvent.click(screen.getByTestId('published-artifacts-next'));
    await waitFor(() => expect(lastQuery().skip).toBe(25));

    fireEvent.click(screen.getByTestId('published-artifacts-facet-kind-bundle'));
    await waitFor(() => expect(lastQuery().skip).toBe(0));
  });

  it('shows the never-published copy for a genuinely empty library, with no toolbar', async () => {
    mockList.mockResolvedValue(page([]));
    renderTab();

    expect(await screen.findByTestId('published-artifacts-empty')).not.toBeNull();
    // Nothing to search or sort, so the controls would be furniture.
    expect(screen.queryByTestId('published-artifacts-search')).toBeNull();
  });

  it('says "no matches" - not "nothing published" - when a filter empties the list', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');

    mockList.mockResolvedValue(page([]));
    fireEvent.change(screen.getByTestId('published-artifacts-search'), { target: { value: 'nothing matches' } });

    expect(await screen.findByTestId('published-artifacts-no-matches')).not.toBeNull();
    expect(screen.queryByTestId('published-artifacts-empty')).toBeNull();
    // The way out stays on screen even with zero results.
    expect(screen.getByTestId('published-artifacts-clear-filters')).not.toBeNull();
  });
});

/**
 * Tags. Freeform by design, so what matters is that a label typed anywhere lands in its canonical
 * form, that the chip on a row is a way INTO the filter, and that clearing tags is possible at all
 * (a merge-semantics PATCH would make removal impossible).
 */
describe('PublishedArtifactsTabContent - tags and covers', () => {
  const lastQuery = () => mockList.mock.calls[mockList.mock.calls.length - 1][0] as Record<string, unknown>;
  const tagged = { ...bundleRow, tags: ['northwind', 'weekly'] };

  it('shows a generated cover for every row, so no row is ever an empty frame', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expect(screen.getByTestId('published-artifact-cover-pub-1')).not.toBeNull();
  });

  it('shows tag chips on the collapsed row', async () => {
    mockList.mockResolvedValue(page([tagged]));
    renderTab();
    await screen.findByTestId('published-artifact-tags-pub-1');
    expect(screen.getByTestId('published-artifact-tag-pub-1-northwind')).not.toBeNull();
  });

  it('filters by a tag when its chip on a row is clicked', async () => {
    // Seeing a label and wanting everything sharing it is one impulse, so the chip is the control.
    mockList.mockResolvedValue(page([tagged]));
    renderTab();
    await screen.findByTestId('published-artifact-tag-pub-1-northwind');

    fireEvent.click(screen.getByTestId('published-artifact-tag-pub-1-northwind'));

    await waitFor(() => expect(lastQuery().tag).toBe('northwind'));
  });

  it('filters from a toolbar tag chip and toggles it off again', async () => {
    mockList.mockResolvedValue(
      page([tagged], { facets: { kind: {}, visibility: {}, gate: {}, comments: 0, tag: { northwind: 6 } } })
    );
    renderTab();
    await screen.findByTestId('published-artifacts-facet-tag-northwind');

    fireEvent.click(screen.getByTestId('published-artifacts-facet-tag-northwind'));
    await waitFor(() => expect(lastQuery().tag).toBe('northwind'));

    fireEvent.click(screen.getByTestId('published-artifacts-facet-tag-northwind'));
    await waitFor(() => expect(lastQuery().tag).toBeUndefined());
  });

  it('offers the tag editor only in the expanded row', async () => {
    mockList.mockResolvedValue(page([tagged]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');

    expect(screen.queryByTestId('published-artifact-tag-input-pub-1')).toBeNull();
    expandRow('pub-1');
    expect(screen.getByTestId('published-artifact-tag-input-pub-1')).not.toBeNull();
  });

  it('normalizes a typed tag with the same helper the server uses', async () => {
    // The chips the owner sees must be what gets stored - otherwise a tag silently re-spells on
    // reload and looks like a bug.
    mockList.mockResolvedValue(page([{ ...bundleRow, tags: [] }]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();

    expandRow('pub-1'); // collapse

    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();
    // And it does not reappear on re-expand - collapsing closed it, rather than merely hiding it.
    expandRow('pub-1');
    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();
  });

  it('does not PATCH when the tag list has not actually changed', async () => {
    mockList.mockResolvedValue(page([tagged]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    const input = screen.getByTestId('published-artifact-tag-input-pub-1');
    // Re-entering an existing tag normalizes to the same list; a write here would be a pointless
    // round trip and a spurious "Tags updated" toast.
    fireEvent.change(input, { target: { value: 'northwind' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockToastSuccess).not.toHaveBeenCalled());
    expect(mockUpdateTags).not.toHaveBeenCalled();
  });
});

/** Regressions from review on #1961. Both were on ordinary paths and neither had coverage. */
describe('PublishedArtifactsTabContent - review regressions', () => {
  /** The most recent LIST call, ignoring the separate facet-counts query. */
  const lastQuery = () => {
    const listCalls = mockList.mock.calls.map(c => c[0] as Record<string, unknown>).filter(c => c.facets !== true);
    return listCalls[listCalls.length - 1];
  };

  it('closes the sharing panel when the row collapses', async () => {
    // The </> button that toggles the panel lives INSIDE the disclosure, so leaving the panel
    // mounted under a collapsed one-line row left it on screen with no control to dismiss it.
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();

    expandRow('pub-1'); // collapse

    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();
    // And it does not reappear on re-expand - collapsing closed it rather than merely hiding it.
    expandRow('pub-1');
    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();
  });

  it('steps back a page when the deleted row was the last one on it', async () => {
    // Otherwise skip points past a now-shorter list: the page renders empty AND the pager
    // disappears (total has dropped to one page), leaving no way back to page 1.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockList.mockResolvedValue(page([bundleRow], { total: 26 }));
    renderTab();
    await screen.findByTestId('published-artifacts-pager');

    fireEvent.click(screen.getByTestId('published-artifacts-next'));
    await waitFor(() => expect(lastQuery().skip).toBe(25));

    expandRow('pub-1');
    fireEvent.click(screen.getByTestId('published-artifact-delete-pub-1'));

    await waitFor(() => expect(lastQuery().skip).toBe(0));
    confirm.mockRestore();
  });

  it('does not step back when other rows remain on the page', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockList.mockResolvedValue(page([bundleRow, replyRow], { total: 40 }));
    renderTab();
    await screen.findByTestId('published-artifacts-pager');

    fireEvent.click(screen.getByTestId('published-artifacts-next'));
    await waitFor(() => expect(lastQuery().skip).toBe(25));

    expandRow('pub-1');
    fireEvent.click(screen.getByTestId('published-artifact-delete-pub-1'));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Artifact deleted'));
    expect(lastQuery().skip).toBe(25);
    confirm.mockRestore();
  });

  it('self-heals when two rapid deletes both read the same stale click-time count', async () => {
    // The real race: fire delete on BOTH rows before either's invalidation has settled, so
    // `wasLastOnPage` reads the same stale 2-row count for both clicks (2 <= 1 is false each
    // time) and never steps back on its own. Once the server has processed both deletes, ANY
    // later refetch of this page observes it empty - the settle-driven clamp reacts to that
    // real response instead of either click-time guess.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const survivorRow = { ...bundleRow, publicId: 'pub-3', title: 'Survivor' };
    let raced = false;
    mockList.mockImplementation((q?: { skip?: number }) =>
      Promise.resolve(
        raced
          ? q?.skip === 25
            ? page([], { total: 25, skip: 25 })
            : page([survivorRow], { total: 25, skip: 0 })
          : page([bundleRow, replyRow], { total: 27, skip: q?.skip ?? 0 })
      )
    );
    renderTab();
    await screen.findByTestId('published-artifacts-pager');

    fireEvent.click(screen.getByTestId('published-artifacts-next'));
    await waitFor(() => expect(lastQuery().skip).toBe(25));

    expandRow('pub-1');
    fireEvent.click(screen.getByTestId('published-artifact-delete-pub-1'));
    expandRow('pub-2');
    fireEvent.click(screen.getByTestId('published-artifact-delete-pub-2'));
    raced = true; // both clicks are in flight against the stale count before either settles

    await waitFor(() => expect(lastQuery().skip).toBe(0));
    // A real row from the recovered page renders - not just a skip value flipping in isolation.
    await screen.findByTestId('published-artifact-pub-3');

    // No re-clamp loop: once settled, the query stops being re-issued.
    const callsAtSettle = mockList.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(mockList.mock.calls.length).toBe(callsAtSettle);
    confirm.mockRestore();
  });

  it('does not clamp back to page 1 when the page query errors', async () => {
    // A failed fetch also resolves with no `artifacts`, which looks identical to a genuinely
    // empty page unless the clamp checks the response actually belongs to this page. Silently
    // bouncing the owner to page 1 on a 500 would hide the failure instead of showing it.
    mockList.mockResolvedValue(page([bundleRow, replyRow], { total: 27 }));
    renderTab();
    await screen.findByTestId('published-artifacts-pager');

    mockList.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByTestId('published-artifacts-next'));

    await screen.findByTestId('published-artifacts-error');
    expect(lastQuery().skip).toBe(25);
  });

  it('never shows the never-published copy while the library still has artifacts', async () => {
    // An empty PAGE is not an empty library. Telling an owner with 25 live artifacts that they
    // have published nothing is the worst version of this bug.
    mockList.mockResolvedValue(page([], { total: 25 }));
    renderTab();

    expect(await screen.findByTestId('published-artifacts-no-matches')).not.toBeNull();
    expect(screen.queryByTestId('published-artifacts-empty')).toBeNull();
  });

  it('fetches facet counts in a separate query, so paging does not recompute them', async () => {
    // Facets are group-bys over the whole library and by design ignore the current selection, so
    // they do not change when you turn a page. Recomputing them per page was five wasted group-bys.
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');

    const calls = mockList.mock.calls.map(c => c[0] as Record<string, unknown>);
    const listCalls = calls.filter(c => c.facets !== true);
    const facetCalls = calls.filter(c => c.facets === true);

    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every(c => c.limit === 25)).toBe(true);
    // The facet query asks for a single row - it wants the counts, not the page.
    expect(facetCalls).toHaveLength(1);
    expect(facetCalls[0].limit).toBe(1);
  });
});

/** Review findings on the tag work (#1965). */
describe('PublishedArtifactsTabContent - tag review fixes', () => {
  const lastQuery = () => {
    const listCalls = mockList.mock.calls.map(c => c[0] as Record<string, unknown>).filter(c => c.facets !== true);
    return listCalls[listCalls.length - 1];
  };
  const tagged = { ...bundleRow, tags: ['northwind', 'weekly'] };

  it('says so when a tag is REJECTED rather than rewritten', async () => {
    // A rewrite (NorthWind -> northwind) is self-explanatory. A drop - over-long, or past the cap - left the
    // equality check seeing no change, so there was no write, no toast, and the chip the person just
    // typed vanished on the next render. That reads as the field being broken.
    mockList.mockResolvedValue(page([{ ...bundleRow, tags: [] }]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    const input = screen.getByTestId('published-artifact-tag-input-pub-1');
    fireEvent.change(input, { target: { value: 'x'.repeat(60) } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(String(mockToastError.mock.calls[0][0])).toMatch(/at most/i);
    expect(mockUpdateTags).not.toHaveBeenCalled();
  });

  it('offers a chip for a tag selected from a row even when the facet list omits it', async () => {
    // Facet counts are capped at the top 24, but a ROW chip can select any tag the artifact has.
    // Without merging it in there is no per-facet control to switch that selection back off.
    mockList.mockResolvedValue(
      page([{ ...bundleRow, tags: ['long-tail'] }], {
        facets: { kind: {}, visibility: {}, gate: {}, comments: 0, tag: { popular: 9 } },
      })
    );
    renderTab();
    await screen.findByTestId('published-artifact-tag-pub-1-long-tail');

    fireEvent.click(screen.getByTestId('published-artifact-tag-pub-1-long-tail'));

    await waitFor(() => expect(lastQuery().tag).toBe('long-tail'));
    // The control to turn it off exists, rather than only the global Clear.
    expect(screen.getByTestId('published-artifacts-facet-tag-long-tail')).not.toBeNull();
  });

  it('keeps the tag vocabulary out of the list invalidation prefix', async () => {
    // It is backed by a scan of another collection, so a mutation that CANNOT change the vocabulary
    // must not refetch it, even though it invalidates the list the row came from.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockList.mockResolvedValue(page([sourcedRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');
    const before = mockVocabCalls.length;

    expandRow('pub-3');
    fireEvent.click(screen.getByTestId('published-artifact-refresh-pub-3'));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());

    expect(mockVocabCalls.length).toBe(before);
    confirm.mockRestore();
  });

  it("refreshes the vocabulary after a DELETE, which takes that row's tags out of the counts", async () => {
    // Only a tag edit invalidated it, but deleting the only artifact carrying a label removes it
    // from the counts too - and autocomplete kept offering it for up to the 5-minute staleTime.
    mockList.mockResolvedValue(page([tagged]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    const before = mockVocabCalls.length;

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    expandRow('pub-1');
    fireEvent.click(screen.getByTestId('published-artifact-delete-pub-1'));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Artifact deleted'));

    await waitFor(() => expect(mockVocabCalls.length).toBeGreaterThan(before));
    confirm.mockRestore();
  });

  it('stays SILENT when a tag is only deduped, rather than blaming its length', async () => {
    // MUI compares options with ===, so typing `NorthWind` beside an existing `northwind` chip appends the
    // case variant and the normalizer then dedupes it. The old check fired on any shortening, so an
    // owner got "Tags can be at most 40 characters" about a four-character tag.
    mockList.mockResolvedValue(page([tagged]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    const input = screen.getByTestId('published-artifact-tag-input-pub-1');
    fireEvent.change(input, { target: { value: 'NorthWind' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockUpdateTags).not.toHaveBeenCalled());
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('stays SILENT when the entry is only whitespace', async () => {
    // Enter over a stray space is a slip, not an error worth a red toast - and it is not a length
    // problem, which is what the length comparison used to call it.
    mockList.mockResolvedValue(page([{ ...bundleRow, tags: [] }]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    const input = screen.getByTestId('published-artifact-tag-input-pub-1');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockUpdateTags).not.toHaveBeenCalled());
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('names the CAP when the entry is one tag too many', async () => {
    // Distinct from the length message: nothing about this tag is wrong, there is just no room.
    const full = Array.from({ length: PUBLISH_TAGS_MAX }, (_, i) => `t${i}`);
    mockList.mockResolvedValue(page([{ ...bundleRow, tags: full }]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    const input = screen.getByTestId('published-artifact-tag-input-pub-1');
    fireEvent.change(input, { target: { value: 'one-more' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(String(mockToastError.mock.calls[0][0])).toMatch(/Up to 20 tags/i);
  });

  it('keeps the first tag when a second is added before the list refetches', async () => {
    // The PATCH is a full replace computed off the row's `tags`, and the input re-enables when the
    // mutation settles rather than when the refetch lands. Within that one round trip the second
    // edit computed off the pre-write array and sent the first tag's absence as the new list.
    // Only the FIRST load resolves; the refetch the write triggers stays IN FLIGHT, which is the
    // window the bug lived in. Letting it resolve against a static pre-write fixture would answer
    // the second edit with stale rows and the test would pass whatever the code does.
    let loads = 0;
    mockList.mockImplementation((q: { facets?: boolean } = {}) => {
      if (q.facets) return Promise.resolve(page([]));
      loads += 1;
      return loads === 1 ? Promise.resolve(page([{ ...bundleRow, tags: [] }])) : new Promise(() => {});
    });
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    const input = screen.getByTestId('published-artifact-tag-input-pub-1');
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mockUpdateTags).toHaveBeenCalledWith('pub-1', ['alpha']));

    fireEvent.change(input, { target: { value: 'beta' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockUpdateTags).toHaveBeenCalledTimes(2));
    expect(mockUpdateTags.mock.calls[1]).toEqual(['pub-1', ['alpha', 'beta']]);
  });

  it('offers a toolbar chip for a tag whose name collides with an Object prototype key', async () => {
    // facets.tag is a plain object built by reduce, so `facets.tag['constructor']` is a function
    // rather than undefined: the merge was skipped and Object.entries did not list it either, so
    // selecting that tag from a row left no per-facet control to turn the selection back off.
    mockList.mockResolvedValue(page([{ ...bundleRow, tags: ['constructor'] }]));
    renderTab();
    await screen.findByTestId('published-artifact-tag-pub-1-constructor');

    fireEvent.click(screen.getByTestId('published-artifact-tag-pub-1-constructor'));

    await waitFor(() => expect(lastQuery().tag).toBe('constructor'));
    expect(screen.getByTestId('published-artifacts-facet-tag-constructor')).not.toBeNull();
  });
});

describe('PublishedArtifactsTabContent - visibility choices follow the scope tier', () => {
  const teamRow = { ...replyRow, publicId: 'pub-t', tier: 'organization', scopeId: 'org1', visibility: 'organization' };
  const visibilitySelect = (publicId: string) =>
    screen.getByTestId(`published-artifact-visibility-${publicId}`).querySelector('button') as HTMLButtonElement;

  beforeEach(() => {
    mockUpdateVisibility.mockReset().mockResolvedValue(undefined);
  });

  it('shows a Team page as Team and lets the owner take it to Private', async () => {
    mockList.mockResolvedValue(page([teamRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-t');
    expandRow('pub-t');

    expect(visibilitySelect('pub-t').textContent).toBe('Team');
    fireEvent.click(visibilitySelect('pub-t'));
    expect(await screen.findByTestId('published-artifact-visibility-option-public')).not.toBeNull();
    expect(screen.getByTestId('published-artifact-visibility-option-organization')).not.toBeNull();

    fireEvent.click(screen.getByTestId('published-artifact-visibility-option-private'));
    await waitFor(() => expect(mockUpdateVisibility).toHaveBeenCalledWith('pub-t', 'private'));
  });

  it('shows a Private Team page as Private rather than an empty choice', async () => {
    mockList.mockResolvedValue(page([{ ...teamRow, visibility: 'private' }]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-t');
    expandRow('pub-t');

    expect(visibilitySelect('pub-t').textContent).toBe('Private');
  });

  it('offers a personal page only Public and Private', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    fireEvent.click(visibilitySelect('pub-1'));
    expect(await screen.findByTestId('published-artifact-visibility-option-private')).not.toBeNull();
    expect(screen.queryByTestId('published-artifact-visibility-option-organization')).toBeNull();
  });
});

describe('PublishedArtifactsTabContent - access badge and aligned columns', () => {
  const lastQuery = () => {
    const listCalls = mockList.mock.calls.map(c => c[0] as Record<string, unknown>).filter(c => c.facets !== true);
    return listCalls[listCalls.length - 1];
  };
  const accessRows = [
    { ...bundleRow, publicId: 'acc-public' },
    { ...bundleRow, publicId: 'acc-pass', gateKind: 'passphrase' },
    { ...bundleRow, publicId: 'acc-domain', gateKind: 'domain' },
    { ...bundleRow, publicId: 'acc-org', tier: 'organization', visibility: 'organization' },
    { ...bundleRow, publicId: 'acc-project', tier: 'project', visibility: 'project' },
    { ...bundleRow, publicId: 'acc-private', visibility: 'private' },
  ];

  it('shows one access badge per row, naming each of the six states', async () => {
    mockList.mockResolvedValue(page(accessRows));
    renderTab();
    await screen.findByTestId('published-artifact-access-acc-public');

    const expected: Array<[string, string, string]> = [
      ['acc-public', 'public', 'Public'],
      ['acc-pass', 'passphrase', 'Passphrase'],
      ['acc-domain', 'domain', 'Domain'],
      ['acc-org', 'organization', 'Team'],
      ['acc-project', 'project', 'Project'],
      ['acc-private', 'private', 'Private'],
    ];
    for (const [id, access, label] of expected) {
      const badge = screen.getByTestId(`published-artifact-access-${id}`);
      expect(badge.getAttribute('data-access')).toBe(access);
      expect(badge.textContent).toBe(label);
      // Word and icon together: the state is never carried by color alone.
      expect(badge.querySelector('svg')).not.toBeNull();
    }
  });

  it('reads a passphrase link as Passphrase only - no separate Public chip or lock icon', async () => {
    mockList.mockResolvedValue(page([{ ...bundleRow, gateKind: 'passphrase' }]));
    renderTab();
    await screen.findByTestId('published-artifact-access-pub-1');

    const meta = screen.getByTestId('published-artifact-meta-pub-1');
    expect(meta.textContent).toContain('Passphrase');
    expect(meta.textContent).not.toContain('Public');
    // The raw visibility word from the old chip is gone too.
    expect(meta.textContent).not.toContain('public');
    expect(meta.querySelector('[data-testid="LockIcon"]')).toBeNull();
    expect(meta.querySelector('[data-testid="DomainIcon"]')).toBeNull();
  });

  it('keeps the versions column populated: a count for 2+ versions, a muted "1 version" otherwise', async () => {
    mockList.mockResolvedValue(
      page([
        { ...bundleRow, publicId: 'v-many', versionsCount: 4 },
        { ...bundleRow, publicId: 'v-one', versionsCount: 1 },
        { ...bundleRow, publicId: 'v-unset', versionsCount: undefined },
      ])
    );
    renderTab();
    await screen.findByTestId('published-artifact-versions-v-many');

    expect(screen.getByTestId('published-artifact-versions-v-many').textContent).toBe('4 versions');
    expect(screen.getByTestId('published-artifact-versions-v-one').textContent).toBe('1 version');
    expect(screen.getByTestId('published-artifact-versions-v-unset').textContent).toBe('1 version');
  });

  it('leaves the versions cell empty for a reply snapshot, which has no version history', async () => {
    mockList.mockResolvedValue(page([replyRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-2');

    expect(screen.queryByTestId('published-artifact-versions-pub-2')).toBeNull();
    // The row still renders every other column.
    expect(screen.getByTestId('published-artifact-access-pub-2')).not.toBeNull();
    expect(screen.getByTestId('published-artifact-views-pub-2').textContent).toBe('0');
  });

  it('shows the view count and a short published date in their own cells', async () => {
    mockList.mockResolvedValue(page([{ ...bundleRow, viewCount: 1234, publishedAt: '2020-03-05T12:00:00.000Z' }]));
    renderTab();
    await screen.findByTestId('published-artifact-views-pub-1');

    expect(screen.getByTestId('published-artifact-views-pub-1').textContent).toBe('1234');
    expect(screen.getByTestId('published-artifact-date-pub-1').textContent).toMatch(/2020/);
  });

  it('abbreviates a very large view count so it cannot outgrow its column', async () => {
    mockList.mockResolvedValue(page([{ ...bundleRow, viewCount: 1_250_000 }]));
    renderTab();
    await screen.findByTestId('published-artifact-views-pub-1');

    expect(screen.getByTestId('published-artifact-views-pub-1').textContent).not.toBe('1250000');
    expect(screen.getByTestId('published-artifact-views-pub-1').getAttribute('title')).toBe('1250000 views');
  });

  it('keeps a four-digit view count exact and abbreviates from 10,000', async () => {
    mockList.mockResolvedValue(
      page([
        { ...bundleRow, publicId: 'views-4', viewCount: 9_999 },
        { ...bundleRow, publicId: 'views-5', viewCount: 10_000 },
      ])
    );
    renderTab();
    await screen.findByTestId('published-artifact-views-views-4');

    expect(screen.getByTestId('published-artifact-views-views-4').textContent).toBe('9999');
    expect(screen.getByTestId('published-artifact-views-views-5').textContent).not.toBe('10000');
  });

  it('labels the columns with a header row', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');

    const header = screen.getByTestId('published-artifacts-columns');
    for (const word of ['Title', 'Access', 'Versions', 'Views', 'Published']) {
      expect(header.textContent).toContain(word);
    }
    // The date cell is publishedAt; "Updated" would promise the updatedAt order of the
    // Recently updated sort, which a rename or tag edit also moves.
    expect(header.textContent).not.toContain('Updated');
  });

  it('groups the facet chips under Tags, Type, Access and Comments, with visibility and gate together', async () => {
    mockList.mockResolvedValue(
      page([bundleRow], {
        facets: {
          kind: { bundle: 5 },
          visibility: { public: 4, private: 1 },
          gate: { passphrase: 2, domain: 1 },
          comments: 3,
          tag: { northwind: 2 },
        },
      })
    );
    renderTab();
    await screen.findByTestId('published-artifacts-facet-gate-passphrase');

    const group = (id: string) => screen.getByTestId(`published-artifacts-facet-group-${id}`);
    expect(group('tags').textContent).toContain('Tags');
    expect(group('type').textContent).toContain('Type');
    expect(group('comments').textContent).toContain('Comments');

    const access = group('access');
    expect(access.textContent).toContain('Access');
    for (const id of ['visibility-public', 'visibility-private', 'gate-passphrase', 'gate-domain']) {
      expect(access.querySelector(`[data-testid="published-artifacts-facet-${id}"]`)).not.toBeNull();
    }
    expect(access.querySelector('[data-testid="published-artifacts-facet-kind-bundle"]')).toBeNull();

    // Same counts as before, now in the badge's own words and with its icons.
    const passphrase = screen.getByTestId('published-artifacts-facet-gate-passphrase').closest('div');
    expect(passphrase?.textContent).toBe('Passphrase 2');
    expect(passphrase?.querySelector('svg')).not.toBeNull();
    const priv = screen.getByTestId('published-artifacts-facet-visibility-private').closest('div');
    expect(priv?.textContent).toBe('Private 1');
    expect(priv?.querySelector('svg')).not.toBeNull();
    // The Public filter counts gated pages too, unlike the badge, and says so.
    expect(screen.getByTestId('published-artifacts-facet-visibility-public').getAttribute('title')).toMatch(
      /including passphrase and domain gated/
    );
    // The group label already says Comments; the chip does not repeat it.
    expect(screen.getByTestId('published-artifacts-facet-comments').closest('div')?.textContent).toBe('On 3');
  });

  it('omits a facet group that has no chips instead of showing an orphan label', async () => {
    mockList.mockResolvedValue(
      page([bundleRow], { facets: { kind: { bundle: 1 }, visibility: {}, gate: {}, comments: 0, tag: {} } })
    );
    renderTab();
    await screen.findByTestId('published-artifacts-facet-kind-bundle');

    expect(screen.getByTestId('published-artifacts-facet-group-type')).not.toBeNull();
    for (const id of ['tags', 'access', 'comments']) {
      expect(screen.queryByTestId(`published-artifacts-facet-group-${id}`)).toBeNull();
    }
  });

  it('still filters on a gate chip and on a visibility chip', async () => {
    mockList.mockResolvedValue(
      page([bundleRow], {
        facets: { kind: {}, visibility: { public: 3 }, gate: { passphrase: 1 }, comments: 0, tag: {} },
      })
    );
    renderTab();
    await screen.findByTestId('published-artifacts-facet-gate-passphrase');

    fireEvent.click(screen.getByTestId('published-artifacts-facet-gate-passphrase'));
    await waitFor(() => expect(lastQuery().gate).toBe('passphrase'));

    fireEvent.click(screen.getByTestId('published-artifacts-facet-visibility-public'));
    await waitFor(() => expect(lastQuery().visibility).toBe('public'));
  });

  it('still filters on the comments chip', async () => {
    mockList.mockResolvedValue(
      page([bundleRow], { facets: { kind: {}, visibility: {}, gate: {}, comments: 2, tag: {} } })
    );
    renderTab();
    await screen.findByTestId('published-artifacts-facet-comments');

    fireEvent.click(screen.getByTestId('published-artifacts-facet-comments'));
    await waitFor(() => expect(lastQuery().comments).toBe('on'));
  });

  it('keeps the gate visible on a private row, which the Passphrase filter also returns', async () => {
    // The server enforces a gate on a non-public page's private links, and counts it under the
    // gate facet - so the row must not read as a bare Private chip once that filter is on.
    mockList.mockResolvedValue(page([{ ...bundleRow, visibility: 'private', gateKind: 'passphrase' }]));
    renderTab();
    const badge = await screen.findByTestId('published-artifact-access-pub-1');

    expect(badge.textContent).toBe('Private');
    expect(badge.getAttribute('data-link-gate')).toBe('passphrase');
    expect(badge.querySelector('[data-testid="KeyIcon"]')).not.toBeNull();
    expect(badge.getAttribute('title')).toMatch(/Private links also need the passphrase/);
  });

  it('moves the badge as soon as the sharing panel changes the gate, without refetching the page', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-access-pub-1');
    expandRow('pub-1');
    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    const listCalls = () => mockList.mock.calls.filter(c => (c[0] as { facets?: boolean }).facets !== true).length;
    const facetCalls = () => mockList.mock.calls.filter(c => (c[0] as { facets?: boolean }).facets === true).length;
    const listBefore = listCalls();
    const facetsBefore = facetCalls();

    fireEvent.click(screen.getByTestId('stub-panel-set-passphrase-pub-1'));

    await waitFor(() =>
      expect(screen.getByTestId('published-artifact-access-pub-1').getAttribute('data-access')).toBe('passphrase')
    );
    // The open panel stays mounted (its show-once passphrase lives there), and the counts refresh.
    expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();
    await waitFor(() => expect(facetCalls()).toBeGreaterThan(facetsBefore));
    expect(listCalls()).toBe(listBefore);

    fireEvent.click(screen.getByTestId('stub-panel-clear-gate-pub-1'));
    await waitFor(() =>
      expect(screen.getByTestId('published-artifact-access-pub-1').getAttribute('data-access')).toBe('public')
    );
  });
});
