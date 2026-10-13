import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { LAKE_SKIPPED_FILE_REASONS, type LakeSkippedFileView } from '@bike4mind/common';

const h = vi.hoisted(() => ({ skipped: vi.fn() }));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useDataLakeSkippedFiles: (lakeId: string | undefined, enabled: boolean) => h.skipped(lakeId, enabled),
}));

import LakeSkippedFilesChip from './LakeSkippedFilesChip';
import { SKIPPED_FILE_REASON_LABELS, skippedFilesChipLabel } from './skippedFileReasons';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const file = (over: Partial<LakeSkippedFileView> = {}): LakeSkippedFileView => ({
  id: 'skip-1',
  sourceKind: 'google_drive',
  sourceId: 'drive-1',
  name: 'big-video.mov',
  reason: 'oversized',
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-02T00:00:00.000Z',
  ...over,
});

const state = (over: Record<string, unknown> = {}) => ({
  data: { pages: [], pageParams: [] },
  files: [file()],
  total: 1,
  hasMore: false,
  loadMore: vi.fn(),
  isLoadingMore: false,
  isLoading: false,
  isError: false,
  isFetchNextPageError: false,
  ...over,
});

const openDialog = () =>
  fireEvent.click(within(screen.getByTestId('datalake-skipped-files-chip-lake-1')).getByRole('button'));

const renderChip = (canManage = true) =>
  render(
    <TestWrapper>
      <LakeSkippedFilesChip lakeId="lake-1" lakeName="Docs" canManage={canManage} />
    </TestWrapper>
  );

describe('LakeSkippedFilesChip', () => {
  beforeEach(() => {
    h.skipped.mockReset();
    h.skipped.mockReturnValue(state());
  });

  it('renders nothing and disables the query when the viewer cannot manage', () => {
    renderChip(false);
    expect(screen.queryByTestId('datalake-skipped-files-chip-lake-1')).toBeNull();
    expect(h.skipped).toHaveBeenCalledWith('lake-1', false);
  });

  it('renders nothing until the first page has loaded, or when that load failed', () => {
    h.skipped.mockReturnValue(state({ data: undefined, files: [], total: 0, isLoading: true }));
    const { unmount } = renderChip();
    expect(screen.queryByTestId('datalake-skipped-files-chip-lake-1')).toBeNull();
    unmount();
    h.skipped.mockReturnValue(state({ data: undefined, files: [], total: 0, isError: true }));
    renderChip();
    expect(screen.queryByTestId('datalake-skipped-files-chip-lake-1')).toBeNull();
  });

  it('keeps the open dialog and its rows when a load-more fails', () => {
    const loaded = state({ hasMore: true, total: 60 });
    h.skipped.mockReturnValue(loaded);
    const { rerender } = renderChip();
    openDialog();

    h.skipped.mockReturnValue({ ...loaded, isError: true, isFetchNextPageError: true });
    rerender(
      <TestWrapper>
        <LakeSkippedFilesChip lakeId="lake-1" lakeName="Docs" canManage />
      </TestWrapper>
    );

    expect(screen.getByTestId('lake-skipped-files-dialog')).toBeTruthy();
    expect(screen.getByTestId('lake-skipped-files-row-skip-1')).toBeTruthy();
    expect(screen.getByTestId('lake-skipped-files-load-more-error')).toBeTruthy();
    expect(screen.queryByTestId('lake-skipped-files-error')).toBeNull();
  });

  it('renders nothing when no file was skipped', () => {
    h.skipped.mockReturnValue(state({ files: [], total: 0 }));
    renderChip();
    expect(screen.queryByTestId('datalake-skipped-files-chip-lake-1')).toBeNull();
  });

  it('labels the chip singular and plural from the total, not the loaded page', () => {
    const { unmount } = renderChip();
    expect(screen.getByTestId('datalake-skipped-files-chip-lake-1').textContent).toBe('1 file not ingested');
    unmount();
    h.skipped.mockReturnValue(state({ files: Array.from({ length: 25 }, (_, i) => file({ id: `s${i}` })), total: 60 }));
    renderChip();
    expect(screen.getByTestId('datalake-skipped-files-chip-lake-1').textContent).toBe('60 files not ingested');
  });

  it('opens the dialog listing the file name and reason', () => {
    renderChip();
    openDialog();
    expect(screen.getByTestId('lake-skipped-files-dialog')).toBeTruthy();
    const row = screen.getByTestId('lake-skipped-files-row-skip-1');
    expect(row.textContent).toContain('big-video.mov');
    expect(row.textContent).toContain(SKIPPED_FILE_REASON_LABELS.oversized);
  });

  it('tells the manager a storage_limit skip will be retried', () => {
    h.skipped.mockReturnValue(state({ files: [file({ reason: 'storage_limit' })] }));
    renderChip();
    openDialog();
    expect(screen.getByTestId('lake-skipped-files-row-skip-1').textContent).toContain('retried once space is freed');
  });

  it('loads the next page on demand', () => {
    const loadMore = vi.fn();
    h.skipped.mockReturnValue(state({ hasMore: true, total: 60, loadMore }));
    renderChip();
    openDialog();
    fireEvent.click(screen.getByTestId('lake-skipped-files-load-more'));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('hides load-more when the list is complete', () => {
    renderChip();
    openDialog();
    expect(screen.queryByTestId('lake-skipped-files-load-more')).toBeNull();
  });
});

describe('skipped file copy', () => {
  it.each(LAKE_SKIPPED_FILE_REASONS)('has a label for %s', reason => {
    expect(SKIPPED_FILE_REASON_LABELS[reason].length).toBeGreaterThan(0);
  });

  it('pluralises the chip label', () => {
    expect(skippedFilesChipLabel(1)).toBe('1 file not ingested');
    expect(skippedFilesChipLabel(2)).toBe('2 files not ingested');
  });
});
