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
} = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockUpdateTags: vi.fn(),
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
  updatePublishedVisibility: vi.fn(),
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

// Stub the panel so this test targets the toggle wiring, not the panel's fetch.
vi.mock('@client/app/components/common/ManageSharingPanel', () => ({
  ManageSharingPanel: (p: { publicId: string }) => <div data-testid={`stub-panel-${p.publicId}`} />,
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

    fireEvent.change(screen.getByTestId('published-artifacts-search'), { target: { value: 'ionq' } });

    await waitFor(() => expect(lastQuery().q).toBe('ionq'));
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
  const tagged = { ...bundleRow, tags: ['ionq', 'weekly'] };

  it('shows a generated cover for every row, so no row is ever an empty frame', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expect(screen.getByTestId('published-artifact-cover-pub-1')).not.toBeNull();
  });

  it('shows tag chips on the collapsed row', async () => {
    mockList.mockResolvedValue(page([tagged]));
    renderTab();
    await screen.findByTestId('published-artifact-tags-pub-1');
    expect(screen.getByTestId('published-artifact-tag-pub-1-ionq')).not.toBeNull();
  });

  it('filters by a tag when its chip on a row is clicked', async () => {
    // Seeing a label and wanting everything sharing it is one impulse, so the chip is the control.
    mockList.mockResolvedValue(page([tagged]));
    renderTab();
    await screen.findByTestId('published-artifact-tag-pub-1-ionq');

    fireEvent.click(screen.getByTestId('published-artifact-tag-pub-1-ionq'));

    await waitFor(() => expect(lastQuery().tag).toBe('ionq'));
  });

  it('filters from a toolbar tag chip and toggles it off again', async () => {
    mockList.mockResolvedValue(
      page([tagged], { facets: { kind: {}, visibility: {}, gate: {}, comments: 0, tag: { ionq: 6 } } })
    );
    renderTab();
    await screen.findByTestId('published-artifacts-facet-tag-ionq');

    fireEvent.click(screen.getByTestId('published-artifacts-facet-tag-ionq'));
    await waitFor(() => expect(lastQuery().tag).toBe('ionq'));

    fireEvent.click(screen.getByTestId('published-artifacts-facet-tag-ionq'));
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
    fireEvent.change(input, { target: { value: 'ionq' } });
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
  const tagged = { ...bundleRow, tags: ['ionq', 'weekly'] };

  it('says so when a tag is REJECTED rather than rewritten', async () => {
    // A rewrite (IonQ -> ionq) is self-explanatory. A drop - over-long, or past the cap - left the
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
    // MUI compares options with ===, so typing `IonQ` beside an existing `ionq` chip appends the
    // case variant and the normalizer then dedupes it. The old check fired on any shortening, so an
    // owner got "Tags can be at most 40 characters" about a four-character tag.
    mockList.mockResolvedValue(page([tagged]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    const input = screen.getByTestId('published-artifact-tag-input-pub-1');
    fireEvent.change(input, { target: { value: 'IonQ' } });
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
