import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

const { mockList, mockExport, mockDownloadData, mockToastError, mockToastSuccess, mockRefresh, mockPrint } = vi.hoisted(
  () => ({
    mockList: vi.fn(),
    mockExport: vi.fn(),
    mockDownloadData: vi.fn(),
    mockToastError: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockRefresh: vi.fn(),
    mockPrint: vi.fn(),
  })
);

vi.mock('sonner', () => ({ toast: { error: mockToastError, success: mockToastSuccess } }));

vi.mock('@client/app/utils/publishApi', () => ({
  listMyPublishedArtifacts: (...a: unknown[]) => mockList(...a),
  deletePublishedArtifact: vi.fn(),
  updatePublishedVisibility: vi.fn(),
  updatePublishedCommentPolicy: vi.fn(),
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
/** A bundle that still knows its in-app source, so it can be refreshed. */
const sourcedRow = { ...bundleRow, publicId: 'pub-3', source: { kind: 'bundle', artifactId: 'artifact_html_x_1_0' } };

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([bundleRow]);
  mockExport.mockReset().mockResolvedValue('# exported');
  mockDownloadData.mockReset();
  mockRefresh.mockReset().mockResolvedValue({ publicId: 'pub-3' });
  mockToastError.mockReset();
  mockToastSuccess.mockReset();
  mockPrint.mockReset();
});

describe('PublishedArtifactsTabContent - manage toggle', () => {
  it('mounts the sharing panel only after the </> toggle is clicked, and unmounts on re-click', async () => {
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');

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

    expect(screen.queryByTestId('published-artifact-copy-md-pub-1')).toBeNull();
    // HTML is faithful for every kind, so that action is always present.
    expect(screen.getByTestId('published-artifact-save-html-pub-1')).not.toBeNull();
  });

  it('copies a reply as Markdown through the authenticated export fetch', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    mockList.mockResolvedValue([replyRow]);
    renderTab();
    await screen.findByTestId('published-artifact-pub-2');

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

    fireEvent.click(screen.getByTestId('published-artifact-save-html-pub-1'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockDownloadData).not.toHaveBeenCalled();
  });

  it('saves as PDF by printing the HTML export - offered for every kind', async () => {
    mockExport.mockResolvedValue('<html><body>bundle</body></html>');
    renderTab();
    await screen.findByTestId('published-artifact-pub-1');

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

    fireEvent.click(screen.getByTestId('published-artifact-save-pdf-pub-1'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockPrint).not.toHaveBeenCalled();
  });
});

describe('PublishedArtifactsTabContent - refresh from source (issue #1142, option 2)', () => {
  it('offers Refresh only for a bundle that still knows its source artifact', async () => {
    mockList.mockResolvedValue([bundleRow, replyRow, sourcedRow]);
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');

    expect(screen.getByTestId('published-artifact-refresh-pub-3')).not.toBeNull();
    // No artifactId (published from outside the app) - nothing to read back.
    expect(screen.queryByTestId('published-artifact-refresh-pub-1')).toBeNull();
    // A reply snapshots an immutable chat message.
    expect(screen.queryByTestId('published-artifact-refresh-pub-2')).toBeNull();
  });

  it('confirms before refreshing, since it replaces what viewers of a live link see', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockList.mockResolvedValue([sourcedRow]);
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');

    fireEvent.click(screen.getByTestId('published-artifact-refresh-pub-3'));
    expect(confirm).toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('refreshes the row on confirm and reports success', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockList.mockResolvedValue([sourcedRow]);
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');

    fireEvent.click(screen.getByTestId('published-artifact-refresh-pub-3'));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'pub-3' })));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    confirm.mockRestore();
  });

  it('surfaces a refresh failure', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockRefresh.mockRejectedValue(new Error('boom'));
    mockList.mockResolvedValue([sourcedRow]);
    renderTab();
    await screen.findByTestId('published-artifact-pub-3');

    fireEvent.click(screen.getByTestId('published-artifact-refresh-pub-3'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastSuccess).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('points the single-version hint at Refresh when the row can use it', async () => {
    mockList.mockResolvedValue([sourcedRow]);
    renderTab();
    const hint = await screen.findByTestId('published-artifact-single-version-pub-3');
    expect(hint.textContent).toContain('refresh it from source');
  });

  it('keeps the generic hint wording when the row cannot be refreshed', async () => {
    renderTab();
    const hint = await screen.findByTestId('published-artifact-single-version-pub-1');
    expect(hint.textContent).toContain('re-publish this artifact');
  });
});
