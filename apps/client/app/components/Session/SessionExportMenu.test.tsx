import React, { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IChatHistoryItemDocument, ISessionDocument } from '@bike4mind/common';
import { useSendToDataLakeStore } from '@client/app/stores/useSendToDataLakeStore';
import { downloadFile } from '@client/app/components/common/DownloadMenu';
import { renderMarkdownToStyledHtml } from '@client/app/utils/markdownToStyledHtml';
import SessionExportMenu from './SessionExportMenu';

/**
 * Gating coverage for the "Send to Data Lake" entry point (issue: the menu item
 * must be hidden when EnableDataLakes is off, matching the rest of the data-lake
 * surface - otherwise it opens the modal into a dead-end empty state that points
 * at a Files entry which is itself hidden).
 */

// The export utils pull in heavy generators (exceljs/docx); the menu only needs
// their return values, so stub the whole module.
vi.mock('@client/app/utils/sessionExport', () => ({
  toExportableSession: vi.fn(() => ({})),
  sessionToMarkdown: vi.fn(() => '# session'),
  sessionToJSON: vi.fn(() => '{}'),
  sessionToCSV: vi.fn(() => ''),
  sessionToExcel: vi.fn(async () => undefined),
  sessionToDocx: vi.fn(async () => undefined),
  getSessionExportFilename: vi.fn(() => 'session-export'),
}));

vi.mock('@client/app/components/common/DownloadMenu', () => ({
  default: () => null,
  downloadFile: vi.fn(),
}));

vi.mock('@client/app/utils/markdownToStyledHtml', () => ({
  renderMarkdownToStyledHtml: vi.fn(async () => '<!DOCTYPE html><html></html>'),
}));

vi.mock('@client/app/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ handleCopyToClipboard: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Default (flag on) is established in beforeEach; tests override per-case.
const isFeatureEnabled = vi.fn();

vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const session = { name: 'Test Session' } as ISessionDocument;
const chatHistory = [] as IChatHistoryItemDocument[];

function renderAndOpenMenu() {
  render(
    <TestWrapper>
      <SessionExportMenu session={session} chatHistory={chatHistory} />
    </TestWrapper>
  );
  fireEvent.click(screen.getByTestId('session-export-menu-btn'));
}

describe('SessionExportMenu - EnableDataLakes gating', () => {
  beforeEach(() => {
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
    useSendToDataLakeStore.setState({ isOpen: false });
  });

  it('shows the Send to Data Lake item (and its Knowledge section) when the feature is on', () => {
    renderAndOpenMenu();

    expect(screen.getByTestId('session-send-to-datalake')).toBeInTheDocument();
    expect(screen.getByText('Knowledge')).toBeInTheDocument();
  });

  it('hides the Send to Data Lake item and the whole Knowledge section when the feature is off', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');

    renderAndOpenMenu();

    expect(screen.queryByTestId('session-send-to-datalake')).not.toBeInTheDocument();
    // The item is the only entry under "Knowledge" - hiding the item must not
    // leave an orphaned section header behind.
    expect(screen.queryByText('Knowledge')).not.toBeInTheDocument();
  });

  it('keeps the export and copy actions available regardless of the flag', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');

    renderAndOpenMenu();

    expect(screen.getByTestId('session-export-markdown')).toBeInTheDocument();
    expect(screen.getByTestId('session-export-json')).toBeInTheDocument();
    expect(screen.getByTestId('session-export-csv')).toBeInTheDocument();
    expect(screen.getByTestId('session-export-excel')).toBeInTheDocument();
    expect(screen.getByTestId('session-export-docx')).toBeInTheDocument();
    expect(screen.getByTestId('session-export-html')).toBeInTheDocument();
    expect(screen.getByTestId('session-copy-markdown')).toBeInTheDocument();
    expect(screen.getByTestId('session-copy-json')).toBeInTheDocument();
  });

  it('exports styled HTML via the shared util when the HTML item is clicked', async () => {
    renderAndOpenMenu();

    fireEvent.click(screen.getByTestId('session-export-html'));

    await waitFor(() =>
      expect(renderMarkdownToStyledHtml).toHaveBeenCalledWith('# session', { title: 'Test Session' })
    );
    await waitFor(() => {
      const [, name, mimeType] = vi.mocked(downloadFile).mock.calls.at(-1)!;
      expect(name).toBe('session-export.html');
      expect(mimeType).toBe('text/html');
    });
  });

  it('still opens the Send to Data Lake modal from the item when the feature is on', () => {
    renderAndOpenMenu();

    fireEvent.click(screen.getByTestId('session-send-to-datalake'));

    expect(useSendToDataLakeStore.getState().isOpen).toBe(true);
    expect(useSendToDataLakeStore.getState().fileName).toBe('session-export.md');
  });
});
