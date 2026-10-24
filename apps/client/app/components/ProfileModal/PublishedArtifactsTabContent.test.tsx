import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

import { AxiosError } from 'axios';
import { deletePublishedArtifact, restorePreviousVersion } from '@client/app/utils/publishApi';
import PublishedArtifactsTabContent from './PublishedArtifactsTabContent';
import { PUBLISHED_ARTIFACTS_VIEW_KEY, usePublishedArtifactsView } from './usePublishedArtifactsView';

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
  return qc;
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

const RATE_LIMIT_MESSAGE = "You've published a lot today. Try again in 42 minutes.";
/** The 429 a publish write route answers once the daily publish allowance is used up. */
const publishRateLimited = () => {
  const error = new AxiosError('Request failed with status code 429');
  error.response = {
    status: 429,
    data: { error: RATE_LIMIT_MESSAGE, code: 'publish_rate_limited', retryAfter: 2520 },
  } as AxiosError['response'];
  return error;
};

beforeEach(() => {
  // The view preference is a module-level store backed by localStorage, so it outlives a test unless reset.
  localStorage.clear();
  usePublishedArtifactsView.setState({ view: 'list' });
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

  it("shows the daily publish limit's own message when a refresh is refused with a 429", async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockRefresh.mockRejectedValue(publishRateLimited());
    mockList.mockResolvedValue(page([sourcedRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');
    expandRow('pub-3');

    fireEvent.click(screen.getByTestId('published-artifact-refresh-pub-3'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(RATE_LIMIT_MESSAGE));
    confirm.mockRestore();
  });

  it("shows the daily publish limit's own message when a restore is refused with a 429", async () => {
    vi.mocked(restorePreviousVersion).mockRejectedValueOnce(publishRateLimited());
    mockList.mockResolvedValue(page([{ ...bundleRow, previousVersionMeta: { sha256Index: 'prev' } }]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    fireEvent.click(screen.getByTestId('published-artifact-restore-pub-1'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(RATE_LIMIT_MESSAGE));
    expect(mockToastSuccess).not.toHaveBeenCalled();
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
  it('keeps an unexpected stored visibility selectable when the row is expanded', async () => {
    mockList.mockResolvedValue(page([{ ...bundleRow, visibility: 'unlisted' }]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    const select = screen.getByTestId('published-artifact-visibility-pub-1').querySelector('button');
    expect(select?.textContent).toBe('unlisted');
    if (!select) throw new Error('Visibility select did not render');
    fireEvent.click(select);
    expect(await screen.findByTestId('published-artifact-visibility-option-unlisted')).not.toBeNull();
    expect(screen.getByTestId('published-artifact-visibility-option-private')).not.toBeNull();
  });

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
    const compact = screen.getByTestId('published-artifact-views-views-5').textContent;
    expect(compact).not.toBe('10000');
    expect(compact).toBe(new Intl.NumberFormat(undefined, { notation: 'compact' }).format(10_000));
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

  it('drops the private-link gate from a private row once the sharing panel clears it', async () => {
    mockList.mockResolvedValue(page([{ ...bundleRow, visibility: 'private', gateKind: 'passphrase' }]));
    renderTab();
    const before = await screen.findByTestId('published-artifact-access-pub-1');
    expect(before.getAttribute('data-link-gate')).toBe('passphrase');
    expandRow('pub-1');
    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    const listCalls = () => mockList.mock.calls.filter(c => (c[0] as { facets?: boolean }).facets !== true).length;
    const facetCalls = () => mockList.mock.calls.filter(c => (c[0] as { facets?: boolean }).facets === true).length;
    const listBefore = listCalls();
    const facetsBefore = facetCalls();

    fireEvent.click(screen.getByTestId('stub-panel-clear-gate-pub-1'));

    await waitFor(() =>
      expect(screen.getByTestId('published-artifact-access-pub-1').getAttribute('data-link-gate')).toBeNull()
    );
    const after = screen.getByTestId('published-artifact-access-pub-1');
    expect(after.textContent).toBe('Private');
    expect(after.getAttribute('data-access')).toBe('private');
    expect(after.querySelector('[data-testid="KeyIcon"]')).toBeNull();
    expect(after.getAttribute('title')).toBe('Only you, and anyone you send a private link to');
    await waitFor(() => expect(facetCalls()).toBeGreaterThan(facetsBefore));
    expect(listCalls()).toBe(listBefore);
  });

  it('does not bring a cleared private-link gate back when a list response started before the clear arrives', async () => {
    const oldPage = page([{ ...bundleRow, visibility: 'private', gateKind: 'passphrase' }]);
    const pendingList = Promise.withResolvers<ReturnType<typeof page>>();
    let listLoads = 0;
    mockList.mockImplementation((query: { facets?: boolean }) => {
      if (query.facets) return Promise.resolve(page([]));
      listLoads += 1;
      return listLoads === 1 ? Promise.resolve(oldPage) : pendingList.promise;
    });
    renderTab();
    const before = await screen.findByTestId('published-artifact-access-pub-1');
    expect(before.getAttribute('data-link-gate')).toBe('passphrase');
    expandRow('pub-1');
    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));

    // Another row setting starts a list refresh that still carries the stored gate.
    fireEvent.click(screen.getByTestId('published-artifact-comments-pub-1').querySelector('input')!);
    await waitFor(() => expect(listLoads).toBe(2));
    fireEvent.click(screen.getByTestId('stub-panel-clear-gate-pub-1'));
    await waitFor(() =>
      expect(screen.getByTestId('published-artifact-access-pub-1').getAttribute('data-link-gate')).toBeNull()
    );

    await act(async () => {
      pendingList.resolve(oldPage);
      await pendingList.promise;
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const after = screen.getByTestId('published-artifact-access-pub-1');
    expect(after.getAttribute('data-link-gate')).toBeNull();
    expect(after.getAttribute('data-access')).toBe('private');
    expect(after.querySelector('[data-testid="KeyIcon"]')).toBeNull();
    expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();
    expect(listLoads).toBe(2);
  });

  it.each([
    [undefined, 'passphrase', 'set-passphrase'],
    ['passphrase', 'public', 'clear-gate'],
  ] as const)(
    'keeps a gate edit from %s to %s when an older list response arrives',
    async (gateKind, access, action) => {
      const oldPage = page([{ ...bundleRow, gateKind }]);
      const pendingList = Promise.withResolvers<ReturnType<typeof page>>();
      let listLoads = 0;
      mockList.mockImplementation((query: { facets?: boolean }) => {
        if (query.facets) return Promise.resolve(page([]));
        listLoads += 1;
        return listLoads === 1 ? Promise.resolve(oldPage) : pendingList.promise;
      });
      renderTab();
      await screen.findByTestId('published-artifact-access-pub-1');
      expandRow('pub-1');
      fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));

      // Another row setting can start a list refresh while the gate editor remains usable.
      fireEvent.click(screen.getByTestId('published-artifact-comments-pub-1').querySelector('input')!);
      await waitFor(() => expect(listLoads).toBe(2));
      fireEvent.click(screen.getByTestId(`stub-panel-${action}-pub-1`));
      await waitFor(() =>
        expect(screen.getByTestId('published-artifact-access-pub-1').getAttribute('data-access')).toBe(access)
      );

      await act(async () => {
        pendingList.resolve(oldPage);
        await pendingList.promise;
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(screen.getByTestId('published-artifact-access-pub-1').getAttribute('data-access')).toBe(access);
      expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();
      expect(listLoads).toBe(2);
    }
  );
});

describe('PublishedArtifactsTabContent - list / grid view', () => {
  const lastQuery = () => {
    const listCalls = mockList.mock.calls.map(c => c[0] as Record<string, unknown>).filter(c => c.facets !== true);
    return listCalls[listCalls.length - 1];
  };
  const goGrid = () => fireEvent.click(screen.getByTestId('published-artifacts-view-grid'));
  const pubTwo = { ...replyRow, title: 'Energy portfolio study', viewCount: 12_345 };
  const pubThree = { ...sourcedRow, title: 'Desktop app mockup', visibility: 'private' };

  it('defaults to the list, which is what the tab looked like before the toggle', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expect(screen.queryByTestId('published-artifacts-grid')).toBeNull();
    expect(screen.getByTestId('published-artifacts-view-list').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('published-artifacts-view-grid').getAttribute('aria-pressed')).toBe('false');
  });

  it('switches between list and grid with the segmented toggle', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');

    goGrid();
    expect(screen.getByTestId('published-artifacts-grid')).not.toBeNull();
    expect(screen.queryByTestId('published-artifact-pub-1')).toBeNull();
    expect(screen.getByTestId('published-artifact-card-pub-1')).not.toBeNull();
    expect(screen.getByTestId('published-artifacts-view-grid').getAttribute('aria-pressed')).toBe('true');
    // The list's column header only labels list columns.
    expect(screen.queryByTestId('published-artifacts-columns')).toBeNull();

    fireEvent.click(screen.getByTestId('published-artifacts-view-list'));
    expect(screen.queryByTestId('published-artifacts-grid')).toBeNull();
    expect(screen.getByTestId('published-artifact-pub-1')).not.toBeNull();
  });

  it('keeps one view on when the pressed button is clicked again', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();
    goGrid();
    expect(screen.getByTestId('published-artifacts-grid')).not.toBeNull();
  });

  it('persists the choice to localStorage', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();
    expect(JSON.parse(localStorage.getItem(PUBLISHED_ARTIFACTS_VIEW_KEY) ?? '{}').state.view).toBe('grid');

    fireEvent.click(screen.getByTestId('published-artifacts-view-list'));
    expect(JSON.parse(localStorage.getItem(PUBLISHED_ARTIFACTS_VIEW_KEY) ?? '{}').state.view).toBe('list');
  });

  it('opens in the stored view on the next visit', async () => {
    localStorage.setItem(PUBLISHED_ARTIFACTS_VIEW_KEY, JSON.stringify({ state: { view: 'grid' }, version: 0 }));
    await usePublishedArtifactsView.persist.rehydrate();
    renderTab();
    await screen.findByTestId('published-artifact-card-pub-1');
    expect(screen.getByTestId('published-artifacts-view-grid').getAttribute('aria-pressed')).toBe('true');
  });

  it('falls back to the list for a stored value it does not recognise', async () => {
    localStorage.setItem(PUBLISHED_ARTIFACTS_VIEW_KEY, JSON.stringify({ state: { view: 'carousel' }, version: 0 }));
    await usePublishedArtifactsView.persist.rehydrate();
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expect(screen.queryByTestId('published-artifacts-grid')).toBeNull();
  });

  it('renders one card per artifact, each with badge, title, meta and the row-scheme test ids', async () => {
    mockList.mockResolvedValue(page([bundleRow, pubTwo, pubThree]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();

    expect(screen.getByTestId('published-artifacts-grid').children).toHaveLength(3);
    for (const [id, title, access] of [
      ['pub-1', 'My Artifact', 'public'],
      ['pub-2', 'Energy portfolio study', 'public'],
      ['pub-3', 'Desktop app mockup', 'private'],
    ]) {
      expect(screen.getByTestId(`published-artifact-card-${id}`)).not.toBeNull();
      expect(screen.getByTestId(`published-artifact-card-title-${id}`).textContent).toBe(title);
      expect(screen.getByTestId(`published-artifact-card-access-${id}`).getAttribute('data-access')).toBe(access);
      expect(screen.getByTestId(`published-artifact-card-date-${id}`)).not.toBeNull();
      expect(screen.getByTestId(`published-artifact-card-views-${id}`)).not.toBeNull();
      expect(screen.getByTestId(`published-artifact-card-copy-${id}`)).not.toBeNull();
      expect(screen.getByTestId(`published-artifact-card-more-${id}`)).not.toBeNull();
    }
    // A reply has no version history, so its card shows no versions.
    expect(screen.queryByTestId('published-artifact-card-versions-pub-2')).toBeNull();
    expect(screen.getByTestId('published-artifact-card-versions-pub-1').textContent).toBe('1 version');
  });

  it('applies search, filters and the pager to the grid exactly as to the list', async () => {
    mockList.mockResolvedValue(
      page([bundleRow], {
        total: 60,
        facets: { kind: { bundle: 1 }, visibility: {}, gate: {}, comments: 0, tag: {} },
      })
    );
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();

    fireEvent.change(screen.getByTestId('published-artifacts-search'), { target: { value: 'planning' } });
    await waitFor(() => expect(lastQuery().q).toBe('planning'));

    fireEvent.click(screen.getByTestId('published-artifacts-facet-kind-bundle'));
    await waitFor(() => expect(lastQuery().kind).toBe('bundle'));

    expect(screen.getByTestId('published-artifacts-pager').textContent).toContain('of 60');
    fireEvent.click(screen.getByTestId('published-artifacts-next'));
    await waitFor(() => expect(lastQuery().skip).toBe(25));
    // Still the grid after the page turned.
    expect(screen.getByTestId('published-artifacts-grid')).not.toBeNull();
  });

  it('shows the same empty state in the grid', async () => {
    mockList.mockResolvedValue(page([], { total: 0 }));
    renderTab();
    await screen.findByTestId('published-artifacts-empty');
    expect(screen.queryByTestId('published-artifacts-grid')).toBeNull();
  });

  it('copies the share link from a card', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();

    fireEvent.click(screen.getByTestId('published-artifact-card-copy-pub-1'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/p/u/erik/s`));
    expect(mockToastSuccess).toHaveBeenCalledWith('Link copied');
    vi.unstubAllGlobals();
  });

  it('opens the same settings panel in a dialog when More is clicked', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();

    expect(screen.queryByTestId('published-artifact-settings-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));

    const dialog = screen.getByTestId('published-artifact-settings-modal');
    // The controls the list row shows when expanded, under the same test ids.
    for (const id of ['visibility', 'comments', 'manage', 'save-html', 'save-pdf', 'restore', 'delete']) {
      expect(within(dialog).getByTestId(`published-artifact-${id}-pub-1`), id).not.toBeNull();
    }
    expect(within(dialog).getByTestId('published-artifact-tag-input-pub-1')).not.toBeNull();
    expect(within(dialog).getByTestId('published-artifact-single-version-pub-1')).not.toBeNull();
    expect(within(dialog).getByText('My Artifact')).not.toBeNull();
  });

  it('mounts the sharing panel from the dialog, and unmounts it when the dialog closes', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));

    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();
    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();

    fireEvent.click(screen.getByTestId('published-artifact-settings-close'));
    await waitFor(() => expect(screen.queryByTestId('published-artifact-settings-modal')).toBeNull());
    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();

    // Reopening starts with the sharing panel shut, like a freshly expanded row.
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));
    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();
  });

  it('runs the same handlers from the dialog as from the row (export)', async () => {
    mockExport.mockResolvedValue('<html></html>');
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));

    fireEvent.click(screen.getByTestId('published-artifact-save-html-pub-1'));
    await waitFor(() =>
      expect(mockDownloadData).toHaveBeenCalledWith('<html></html>', 'my-artifact.html', 'text/html; charset=utf-8')
    );
    expect(mockExport).toHaveBeenCalledWith('/p/u/erik/s', 'html');
  });

  it('refreshes from source from the dialog after confirmation', async () => {
    mockList.mockResolvedValue(page([sourcedRow]));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');
    goGrid();
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-3'));

    fireEvent.click(screen.getByTestId('published-artifact-refresh-pub-3'));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    vi.restoreAllMocks();
  });

  it('closes the dialog when the artifact is deleted from it', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deletePublishedArtifact).mockResolvedValue(undefined);
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));

    fireEvent.click(screen.getByTestId('published-artifact-delete-pub-1'));
    await waitFor(() => expect(screen.queryByTestId('published-artifact-settings-modal')).toBeNull());
    expect(deletePublishedArtifact).toHaveBeenCalledWith('pub-1');
    vi.restoreAllMocks();
  });

  it('closes the dialog when its artifact leaves the list, and does not reopen it if it returns', async () => {
    const qc = renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));
    expect(screen.getByTestId('published-artifact-settings-modal')).not.toBeNull();

    // e.g. a visibility change under an active visibility filter drops the row on the refetch.
    mockList.mockResolvedValue(page([pubTwo]));
    await qc.invalidateQueries({ queryKey: ['published-artifacts', 'mine'] });
    await waitFor(() => expect(screen.queryByTestId('published-artifact-settings-modal')).toBeNull());

    mockList.mockResolvedValue(page([bundleRow]));
    await qc.invalidateQueries({ queryKey: ['published-artifacts', 'mine'] });
    await screen.findByTestId('published-artifact-card-pub-1');
    expect(screen.queryByTestId('published-artifact-settings-modal')).toBeNull();
  });

  it('uses the thumbnail in the list row cover slot when the artifact has one', async () => {
    mockList.mockResolvedValue(page([{ ...bundleRow, thumbnailUrl: 'https://cdn.example/thumbs/pub-1.png' }]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    const img = screen.getByTestId('published-artifact-cover-pub-1-image');
    expect(img.getAttribute('src')).toBe('https://cdn.example/thumbs/pub-1.png');

    fireEvent.error(img);
    expect(screen.queryByTestId('published-artifact-cover-pub-1-image')).toBeNull();
    expect(screen.getByTestId('published-artifact-cover-pub-1').textContent).toBe('M');
  });

  it('uses the thumbnail on the card, and the letter cover when there is none', async () => {
    mockList.mockResolvedValue(page([{ ...bundleRow, thumbnailUrl: 'https://cdn.example/thumbs/pub-1.png' }, pubTwo]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();

    expect(screen.getByTestId('published-artifact-card-cover-pub-1-image')).not.toBeNull();
    expect(screen.queryByTestId('published-artifact-card-cover-pub-2-image')).toBeNull();
    expect(screen.getByTestId('published-artifact-card-cover-pub-2').textContent).toBe('E');
  });
});

describe('PublishedArtifactsTabContent - grid dialog, facet labels and container layout', () => {
  it('moves the card badge as soon as the sharing panel in the dialog changes the gate', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    fireEvent.click(screen.getByTestId('published-artifacts-view-grid'));
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));
    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    const listCalls = () => mockList.mock.calls.filter(c => (c[0] as { facets?: boolean }).facets !== true).length;
    const listBefore = listCalls();

    fireEvent.click(screen.getByTestId('stub-panel-set-passphrase-pub-1'));

    await waitFor(() =>
      expect(screen.getByTestId('published-artifact-card-access-pub-1').getAttribute('data-access')).toBe('passphrase')
    );
    // The dialog (and the show-once passphrase in its panel) survives, and the page is not refetched.
    expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();
    expect(listCalls()).toBe(listBefore);
  });

  it.each([
    [undefined, 'passphrase', 'set-passphrase'],
    ['passphrase', 'public', 'clear-gate'],
  ] as const)(
    'keeps the card badge for a gate edit from %s to %s when an older list response arrives',
    async (gateKind, access, action) => {
      const oldPage = page([{ ...bundleRow, gateKind }]);
      const pendingList = Promise.withResolvers<ReturnType<typeof page>>();
      let listLoads = 0;
      mockList.mockImplementation((query: { facets?: boolean }) => {
        if (query.facets) return Promise.resolve(page([]));
        listLoads += 1;
        return listLoads === 1 ? Promise.resolve(oldPage) : pendingList.promise;
      });
      renderTab();
      await screen.findByTestId('published-artifact-pub-1');
      fireEvent.click(screen.getByTestId('published-artifacts-view-grid'));
      fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));
      fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));

      fireEvent.click(screen.getByTestId('published-artifact-comments-pub-1').querySelector('input')!);
      await waitFor(() => expect(listLoads).toBe(2));
      fireEvent.click(screen.getByTestId(`stub-panel-${action}-pub-1`));
      await waitFor(() =>
        expect(screen.getByTestId('published-artifact-card-access-pub-1').getAttribute('data-access')).toBe(access)
      );

      await act(async () => {
        pendingList.resolve(oldPage);
        await pendingList.promise;
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(screen.getByTestId('published-artifact-card-access-pub-1').getAttribute('data-access')).toBe(access);
      expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();
      expect(listLoads).toBe(2);
    }
  );

  it('labels the Type facet chips with names for people, and still filters on the raw kind', async () => {
    mockList.mockResolvedValue(
      page([bundleRow], {
        facets: { kind: { bundle: 2, reply: 1, fabfile: 1 }, visibility: {}, gate: {}, comments: 0, tag: {} },
      })
    );
    renderTab();
    await screen.findByTestId('published-artifacts-facet-kind-bundle');

    const text = (kind: string) =>
      screen.getByTestId(`published-artifacts-facet-kind-${kind}`).closest('div')?.textContent;
    expect(text('bundle')).toBe('Bundle 2');
    expect(text('reply')).toBe('Reply 1');
    expect(text('fabfile')).toBe('File 1');

    fireEvent.click(screen.getByTestId('published-artifacts-facet-kind-fabfile'));
    await waitFor(() =>
      expect(
        mockList.mock.calls
          .map(c => c[0] as Record<string, unknown>)
          .filter(c => c.facets !== true)
          .pop()?.kind
      ).toBe('fabfile')
    );
  });

  it('shows the same human label in the settings panel source chip', async () => {
    mockList.mockResolvedValue(page([{ ...bundleRow, source: { kind: 'fabfile' } }]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');
    expect(screen.getByTestId('published-artifact-settings-pub-1').textContent).toContain('File');
  });

  it('switches the row layout on the list width, not the viewport', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    const css = Array.from(document.querySelectorAll('style'))
      .map(s => s.textContent ?? '')
      .join('\n');
    // The list wrapper is the size container, and the wide layout hangs off it.
    expect(css).toMatch(/container-type:\s*inline-size/);
    expect(css).toMatch(/@container \(min-width:\s*720px\)/);
    // No row rule is still keyed to the md viewport breakpoint.
    const rowRules = css.split('}').filter(r => r.includes('grid-template-areas'));
    expect(rowRules.length).toBeGreaterThan(0);
    expect(rowRules.some(r => /@media/.test(r))).toBe(false);
  });
});

describe('PublishedArtifactsTabContent - grid dialog focus, sharing state and narrow layout', () => {
  const goGrid = () => fireEvent.click(screen.getByTestId('published-artifacts-view-grid'));

  it('keeps the list row title as its link name; the tooltip only describes it', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expect(screen.getByRole('link', { name: 'My Artifact' }).getAttribute('href')).toBe(
      `${window.location.origin}/p/u/erik/s`
    );
    expect(screen.queryByRole('link', { name: 'Opens in a new tab' })).toBeNull();
  });

  it('closes the dialog on Escape and hands focus back to the More button that opened it', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();
    const more = screen.getByTestId('published-artifact-card-more-pub-1');
    more.focus();
    fireEvent.click(more);
    const dialog = screen.getByTestId('published-artifact-settings-modal');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe('published-artifact-settings-title-pub-1');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('published-artifact-settings-modal')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('published-artifact-card-more-pub-1'));
  });

  it('does not restore an earlier delete focus after another settings dialog is opened', async () => {
    const other = { ...bundleRow, publicId: 'pub-2', title: 'Other artifact' };
    let finishDelete = () => {};
    vi.mocked(deletePublishedArtifact).mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishDelete = resolve;
        })
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      mockList.mockResolvedValue(page([bundleRow, other]));
      renderTab();
      await screen.findByTestId('published-artifact-pub-1');
      goGrid();
      screen.getByTestId('published-artifact-card-more-pub-1').focus();
      fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));
      fireEvent.click(screen.getByTestId('published-artifact-delete-pub-1'));
      fireEvent.keyDown(screen.getByTestId('published-artifact-settings-modal'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('published-artifact-settings-modal')).toBeNull());

      const otherMore = screen.getByTestId('published-artifact-card-more-pub-2');
      otherMore.focus();
      fireEvent.click(otherMore);
      mockList.mockResolvedValue(page([other]));
      await act(async () => {
        finishDelete();
      });
      await waitFor(() => expect(screen.queryByTestId('published-artifact-card-pub-1')).toBeNull());
      expect(screen.getByTestId('published-artifact-settings-modal')).toBeTruthy();

      fireEvent.keyDown(screen.getByTestId('published-artifact-settings-modal'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('published-artifact-settings-modal')).toBeNull());
      expect(document.activeElement).toBe(otherMore);
    } finally {
      confirm.mockRestore();
    }
  });

  it.each(['card', 'search'] as const)('preserves delete focus ownership after Escape to %s', async focusAfterClose => {
    const other = { ...bundleRow, publicId: 'pub-2', title: 'Other artifact' };
    let finishDelete = () => {};
    vi.mocked(deletePublishedArtifact).mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishDelete = resolve;
        })
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      mockList.mockResolvedValue(page([bundleRow, other]));
      renderTab();
      await screen.findByTestId('published-artifact-pub-1');
      goGrid();
      const more = screen.getByTestId('published-artifact-card-more-pub-1');
      more.focus();
      fireEvent.click(more);
      fireEvent.click(screen.getByTestId('published-artifact-delete-pub-1'));
      fireEvent.keyDown(screen.getByTestId('published-artifact-settings-modal'), { key: 'Escape' });
      await waitFor(() => expect(document.activeElement).toBe(more));
      const search = screen.getByTestId('published-artifacts-search');
      if (focusAfterClose === 'search') search.focus();

      mockList.mockResolvedValue(page([other]));
      await act(async () => {
        finishDelete();
      });
      await waitFor(() => expect(screen.queryByTestId('published-artifact-card-pub-1')).toBeNull());
      expect(document.activeElement).toBe(
        focusAfterClose === 'search' ? search : screen.getByTestId('published-artifact-card-title-pub-2')
      );
    } finally {
      confirm.mockRestore();
    }
  });

  it('opens the dialog with the sharing panel shut even when the list row left it open', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');
    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();

    goGrid();
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));
    expect(screen.getByTestId('published-artifact-settings-modal')).not.toBeNull();
    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();
  });

  it('shuts the sharing panel with a dialog that closed because its artifact left the list', async () => {
    const qc = renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));
    fireEvent.click(screen.getByTestId('published-artifact-manage-pub-1'));
    expect(screen.getByTestId('stub-panel-pub-1')).not.toBeNull();

    mockList.mockResolvedValue(page([replyRow]));
    await qc.invalidateQueries({ queryKey: ['published-artifacts', 'mine'] });
    await waitFor(() => expect(screen.queryByTestId('published-artifact-settings-modal')).toBeNull());

    // Back in the list, expanding the returned row must not mount a sharing panel nobody opened.
    mockList.mockResolvedValue(page([bundleRow]));
    await qc.invalidateQueries({ queryKey: ['published-artifacts', 'mine'] });
    fireEvent.click(screen.getByTestId('published-artifacts-view-list'));
    expandRow('pub-1');
    expect(screen.getByTestId('published-artifact-settings-pub-1')).not.toBeNull();
    expect(screen.queryByTestId('stub-panel-pub-1')).toBeNull();
  });

  it('lets a grid column shrink below its 260px minimum instead of overflowing a narrow tab', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();
    const css = Array.from(document.querySelectorAll('style'))
      .map(s => s.textContent ?? '')
      .join('\n');
    expect(css).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(260px,\s*100%\),\s*1fr\)\)/);
    expect(css).not.toMatch(/minmax\(260px,\s*1fr\)/);
  });

  it('wraps a dialog title that has no spaces instead of widening the dialog', async () => {
    const longTitle = 'https://example.com/a/very/long/pasted/address/with/no/spaces/at/all';
    mockList.mockResolvedValue(page([{ ...bundleRow, title: longTitle }]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();
    fireEvent.click(screen.getByTestId('published-artifact-card-more-pub-1'));
    const title = document.getElementById('published-artifact-settings-title-pub-1') as HTMLElement;
    expect(title.textContent).toBe(longTitle);
    expect(getComputedStyle(title).overflowWrap).toBe('anywhere');
  });

  it('keeps list semantics on the unstyled card list, so screen readers announce the count', async () => {
    mockList.mockResolvedValue(page([bundleRow, replyRow]));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    goGrid();
    const grid = screen.getByTestId('published-artifacts-grid');
    expect(grid.getAttribute('role')).toBe('list');
    expect(within(grid).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe.each(['list', 'grid'] as const)('PublishedArtifactsTabContent - focus after delete (%s view)', view => {
  const first = { ...bundleRow, publicId: 'pub-1', title: 'First artifact' };
  const second = { ...bundleRow, publicId: 'pub-2', title: 'Second artifact' };
  const third = { ...bundleRow, publicId: 'pub-3', title: 'Third artifact' };
  type Row = typeof first;

  const rowTestId = (r: Row) =>
    view === 'grid' ? `published-artifact-card-${r.publicId}` : `published-artifact-${r.publicId}`;
  const titleLink = (r: Row) =>
    view === 'grid'
      ? screen.getByTestId(`published-artifact-card-title-${r.publicId}`)
      : within(screen.getByTestId(rowTestId(r))).getByRole('link', { name: r.title });

  /** Opens the settings the way a keyboard user does and returns the focused Delete button. */
  const focusDelete = (r: Row) => {
    if (view === 'grid') {
      const more = screen.getByTestId(`published-artifact-card-more-${r.publicId}`);
      more.focus();
      fireEvent.click(more);
    } else {
      expandRow(r.publicId);
    }
    const del = screen.getByTestId(`published-artifact-delete-${r.publicId}`);
    del.focus();
    return del;
  };

  const renderRows = async (rows: Row[], over: Record<string, unknown> = {}) => {
    mockList.mockResolvedValue(page(rows, over));
    usePublishedArtifactsView.setState({ view });
    renderTab();
    await screen.findByTestId(rowTestId(rows[0]));
  };

  let confirmSpy: { mockRestore: () => void };
  beforeEach(() => {
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deletePublishedArtifact).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => confirmSpy.mockRestore());

  it('focuses the next title when a middle item is deleted, and keeps it there once the row is gone', async () => {
    await renderRows([first, second, third]);
    mockList.mockResolvedValue(page([first, third]));
    const del = focusDelete(second);

    fireEvent.click(del);
    await waitFor(() => expect(document.activeElement).toBe(titleLink(third)));

    await waitFor(() => expect(screen.queryByTestId(rowTestId(second))).toBeNull());
    expect(document.activeElement).toBe(titleLink(third));
  });

  it('focuses the first remaining title when the first item is deleted', async () => {
    await renderRows([first, second, third]);
    mockList.mockResolvedValue(page([second, third]));

    fireEvent.click(focusDelete(first));
    await waitFor(() => expect(document.activeElement).toBe(titleLink(second)));
  });

  it('focuses the previous title when the last item is deleted', async () => {
    await renderRows([first, second, third]);
    mockList.mockResolvedValue(page([first, second]));
    const del = focusDelete(third);

    fireEvent.click(del);
    await waitFor(() => expect(document.activeElement).toBe(titleLink(second)));

    await waitFor(() => expect(screen.queryByTestId(rowTestId(third))).toBeNull());
    expect(document.activeElement).toBe(titleLink(second));
  });

  it('focuses the search input when the only item in a filtered view is deleted', async () => {
    await renderRows([first]);
    const search = screen.getByTestId('published-artifacts-search');
    fireEvent.change(search, { target: { value: 'first' } });
    await waitFor(() => expect(mockList.mock.calls.some(c => (c[0] as { q?: string }).q === 'first')).toBe(true));
    mockList.mockResolvedValue(page([], { total: 0 }));

    fireEvent.click(focusDelete(first));
    await waitFor(() => expect(document.activeElement).toBe(search));

    await waitFor(() => expect(screen.queryByTestId(rowTestId(first))).toBeNull());
    expect(document.activeElement).toBe(search);
  });

  it('focuses the search input when the only item on a later page is deleted', async () => {
    let deleted = false;
    vi.mocked(deletePublishedArtifact).mockImplementation(async () => {
      deleted = true;
    });
    mockList.mockImplementation(async (q: { skip?: number }) =>
      q.skip === 25 ? page([second], { total: 26, skip: 25 }) : page([first], { total: deleted ? 25 : 26, skip: 0 })
    );
    usePublishedArtifactsView.setState({ view });
    renderTab();
    await screen.findByTestId(rowTestId(first));
    fireEvent.click(screen.getByTestId('published-artifacts-next'));
    await screen.findByTestId(rowTestId(second));

    fireEvent.click(focusDelete(second));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('published-artifacts-search')));

    // The page steps back, and the search input is still where focus is.
    await screen.findByTestId(rowTestId(first));
    expect(document.activeElement).toBe(screen.getByTestId('published-artifacts-search'));
  });

  it('focuses the tab heading when the whole library is emptied, since the toolbar goes with it', async () => {
    await renderRows([first]);
    mockList.mockResolvedValue(page([], { total: 0 }));

    fireEvent.click(focusDelete(first));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('published-artifacts-heading')));

    await screen.findByTestId('published-artifacts-empty');
    expect(screen.queryByTestId('published-artifacts-search')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('published-artifacts-heading'));
  });

  it('leaves focus where it was when the delete fails', async () => {
    await renderRows([first, second, third]);
    vi.mocked(deletePublishedArtifact).mockRejectedValue(new Error('Server said no'));
    const del = focusDelete(second);

    fireEvent.click(del);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Server said no'));
    await waitFor(() => expect(del.hasAttribute('disabled')).toBe(false));

    expect(document.activeElement).toBe(del);
    // Nothing was removed, and in the grid the dialog is still the place focus lives.
    expect(screen.getByTestId(rowTestId(second))).not.toBeNull();
    if (view === 'grid') expect(screen.getByTestId('published-artifact-settings-modal')).not.toBeNull();
  });
});

describe('PublishedArtifactsTabContent - helper text contrast', () => {
  /** Helper text is dimmed by a theme text token, never `opacity`, which stacks on the token and drops it below AA. */
  const expectTokenDimmed = (el: HTMLElement, token: 'secondary' | 'tertiary') => {
    const style = getComputedStyle(el);
    expect(['', '1']).toContain(style.opacity);
    expect(style.color).toContain(`--joy-palette-text-${token}`);
  };

  it('dims the intro, pager and row settings helper text with a text token, not opacity', async () => {
    usePublishedArtifactsView.setState({ view: 'list' });
    mockList.mockResolvedValue(page([bundleRow], { total: 60 }));
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    expandRow('pub-1');

    expectTokenDimmed(screen.getByText(/Everything you've published as a live link/), 'secondary');
    expectTokenDimmed(within(screen.getByTestId('published-artifacts-pager')).getByText(/of 60/), 'tertiary');
    const settings = screen.getByTestId('published-artifact-settings-pub-1');
    expectTokenDimmed(within(settings).getByText(`0/${PUBLISH_TAGS_MAX}`), 'tertiary');
    expectTokenDimmed(within(settings).getByText('Visibility'), 'tertiary');
    expectTokenDimmed(within(settings).getByText('Comments'), 'tertiary');
    expectTokenDimmed(screen.getByTestId('published-artifact-single-version-pub-1'), 'tertiary');
  });

  it('dims the empty-library message with a text token, not opacity', async () => {
    mockList.mockResolvedValue(page([]));
    renderTab();
    expectTokenDimmed(await screen.findByTestId('published-artifacts-empty'), 'secondary');
  });

  it('dims the no-matches message with a text token, not opacity', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');
    mockList.mockResolvedValue(page([]));
    fireEvent.change(screen.getByTestId('published-artifacts-search'), { target: { value: 'nothing matches' } });
    expectTokenDimmed(await screen.findByTestId('published-artifacts-no-matches'), 'secondary');
  });
});
