import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getSetting: vi.fn(),
  updateSettings: vi.fn(),
  setOpen: vi.fn(),
  setSelectedFabFileId: vi.fn(),
  setViewOnly: vi.fn(),
  settingsPending: false,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({ getSetting: mocks.getSetting }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useUpdateSettings: () => ({ mutateAsync: mocks.updateSettings, isPending: mocks.settingsPending }),
}));
vi.mock('../Knowledge/KnowledgeModal', () => ({
  useKnowledgeModal: () => ({
    setOpen: mocks.setOpen,
    setSelectedFabFileId: mocks.setSelectedFabFileId,
    setViewOnly: mocks.setViewOnly,
  }),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import { SystemPromptsManager } from './SystemPromptsManager';

const appTheme = extendTheme({ ...getThemeConfig() });

const STYLE_GUIDE = {
  id: 'file-a',
  fileName: 'style-guide.md',
  mimeType: 'text/markdown',
  fileSize: 2048,
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const TONE = { id: 'file-b', fileName: 'tone.md', mimeType: 'text/markdown', fileSize: 512 };

const FILES_URL = '/api/files';
// The real file-picker query runs against the mocked api, so these are the requests it sends.
const pickerSearches = () =>
  mocks.get.mock.calls
    .filter(([url]) => url === FILES_URL)
    .map(([, config]) => (config as { params: { search: string } }).params.search);

const renderManager = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <SystemPromptsManager />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

describe('SystemPromptsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSetting.mockReturnValue('file-a,file-missing');
    mocks.settingsPending = false;
    mocks.get.mockImplementation((url: string) => {
      if (url === FILES_URL) return Promise.resolve({ data: { data: [TONE, STYLE_GUIDE], hasMore: false, total: 2 } });
      if (url === '/api/files/file-a') return Promise.resolve({ data: STYLE_GUIDE });
      if (url === '/api/files/file-missing') return Promise.reject({ response: { status: 404 } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mocks.updateSettings.mockResolvedValue({});
  });

  it('is a titled section with the files in one table, never a card per file', async () => {
    const { container } = renderManager();

    const title = await screen.findByTestId('system-files-title');
    expect(title).toHaveTextContent('Global knowledge files');
    expect(title.tagName).toBe('H2');
    const table = screen.getByTestId('system-files-table');
    expect(table).toContainElement(await screen.findByTestId('system-files-row-file-a'));
    expect(table).toContainElement(screen.getByTestId('system-files-row-file-missing'));
    expect(table).toHaveStyle({ minWidth: '60rem' });
    expect(container.querySelectorAll('.MuiCard-root')).toHaveLength(0);
  });

  it('marks a missing file with a bad Missing chip and a warning banner, not a tinted card', async () => {
    renderManager();

    const missing = await screen.findByTestId('system-files-status-file-missing');
    expect(missing).toHaveTextContent('Missing');
    expect(missing).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByTestId('system-files-status-file-a')).toHaveAttribute('data-tone', 'good');
    expect(screen.getByTestId('system-files-row-file-missing')).toHaveTextContent('File not found');
    const banner = screen.getByTestId('system-files-missing-banner');
    expect(banner).toHaveTextContent('1 system file could not be found');
    expect(banner).toHaveClass('MuiAlert-colorWarning');
  });

  it('confirms Remove from list in a danger dialog, then sends the same settings update', async () => {
    renderManager();

    fireEvent.click(await screen.findByTestId('system-files-row-actions-file-missing'));
    fireEvent.click(await screen.findByTestId('system-files-row-remove-file-missing'));

    const dialog = await screen.findByTestId('system-files-remove-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Remove knowledge file');
    expect(dialog).toHaveTextContent('file-missing');
    expect(within(dialog).getByTestId('system-files-remove-dialog-reason-input-helper')).toHaveTextContent(
      'Not stored yet'
    );
    const confirm = within(dialog).getByTestId('system-files-remove-dialog-confirm-btn');
    expect(confirm).toHaveTextContent('Remove file');
    expect(confirm).toBeDisabled();
    expect(mocks.updateSettings).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByTestId('system-files-remove-dialog-reason-input-preset-0'));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith(
        { key: 'SystemFiles', value: 'file-a' },
        expect.objectContaining({ onSettled: expect.any(Function) })
      )
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('System file removed successfully');
    await waitFor(() => expect(screen.queryByTestId('system-files-remove-dialog')).toBeNull());
  });

  it('keeps the remove confirm open when the update fails, and while it is in flight', async () => {
    mocks.updateSettings.mockRejectedValue(new Error('boom'));
    const { unmount } = renderManager();

    fireEvent.click(await screen.findByTestId('system-files-row-actions-file-a'));
    fireEvent.click(await screen.findByTestId('system-files-row-remove-file-a'));
    let dialog = await screen.findByTestId('system-files-remove-dialog');
    fireEvent.click(within(dialog).getByTestId('system-files-remove-dialog-reason-input-preset-0'));
    fireEvent.click(within(dialog).getByTestId('system-files-remove-dialog-confirm-btn'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Failed to remove system file'));
    expect(screen.getByTestId('system-files-remove-dialog')).toBeInTheDocument();
    unmount();

    mocks.settingsPending = true;
    renderManager();
    fireEvent.click(await screen.findByTestId('system-files-row-actions-file-a'));
    fireEvent.click(await screen.findByTestId('system-files-row-remove-file-a'));
    dialog = await screen.findByTestId('system-files-remove-dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(within(dialog).getByTestId('system-files-remove-dialog-close-btn'));
    expect(screen.getByTestId('system-files-remove-dialog')).toBeInTheDocument();
  });

  it('searches the picker once typing pauses for 300 ms, with only the last term', async () => {
    renderManager();
    await screen.findByTestId('system-files-row-file-a');
    fireEvent.click(screen.getByTestId('system-files-add-btn'));
    const dialog = await screen.findByTestId('system-files-add-dialog');
    await within(dialog).findByTestId('system-files-pick-file-b');
    expect(pickerSearches()).toEqual(['']);

    vi.useFakeTimers();
    try {
      const input = within(dialog).getByTestId('system-files-search-input');
      fireEvent.change(input, { target: { value: 's' } });
      await act(() => vi.advanceTimersByTimeAsync(100));
      fireEvent.change(input, { target: { value: 'st' } });
      await act(() => vi.advanceTimersByTimeAsync(100));
      fireEvent.change(input, { target: { value: 'sty' } });
      await act(() => vi.advanceTimersByTimeAsync(299));
      expect(pickerSearches()).toEqual(['']);

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(pickerSearches()).toEqual(['', 'sty']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a file read-only from its row menu, and offers no view for a missing one', async () => {
    renderManager();

    fireEvent.click(await screen.findByTestId('system-files-row-actions-file-missing'));
    await screen.findByTestId('system-files-row-remove-file-missing');
    expect(screen.queryByTestId('system-files-row-view-file-missing')).toBeNull();

    fireEvent.click(screen.getByTestId('system-files-row-actions-file-a'));
    fireEvent.click(await screen.findByTestId('system-files-row-view-file-a'));
    expect(mocks.setSelectedFabFileId).toHaveBeenCalledWith('file-a');
    expect(mocks.setViewOnly).toHaveBeenCalledWith(true);
    expect(mocks.setOpen).toHaveBeenCalledWith(true);
  });

  it('adds the picked files from the Add system files dialog with the same settings update', async () => {
    renderManager();
    await screen.findByTestId('system-files-row-file-a');

    fireEvent.click(screen.getByTestId('system-files-add-btn'));
    const dialog = await screen.findByTestId('system-files-add-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Add system files');
    expect(within(dialog).getByTestId('system-files-already-added-file-a')).toHaveAttribute('data-tone', 'neutral');

    const pick = within(dialog).getByTestId('system-files-pick-file-b');
    expect(pick).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pick);
    expect(pick).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByTestId('system-files-selected-count')).toHaveTextContent('1 file(s) selected');
    fireEvent.click(within(dialog).getByTestId('system-files-add-confirm-btn'));

    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith(
        { key: 'SystemFiles', value: 'file-a,file-missing,file-b' },
        expect.objectContaining({ onSettled: expect.any(Function) })
      )
    );
    await waitFor(() => expect(screen.queryByTestId('system-files-add-dialog')).toBeNull());
  });

  it('shows EmptyState with an Add files action when no file is configured', async () => {
    mocks.getSetting.mockReturnValue('');
    renderManager();

    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No knowledge files yet');
    fireEvent.click(within(empty).getByTestId('system-files-empty-add-btn'));
    expect(await screen.findByTestId('system-files-add-dialog')).toBeInTheDocument();
    // No file is configured, so no file is looked up; only the picker's list query runs.
    expect(mocks.get.mock.calls.filter(([url]) => String(url).startsWith('/api/files/'))).toHaveLength(0);
  });
});
