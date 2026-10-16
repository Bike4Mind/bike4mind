import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { FabFileSourceType, type StorageBreakdownResponse } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import StorageBreakdown from './StorageBreakdown';

const mockRefs = vi.hoisted(() => ({
  useGetStorageBreakdown: vi.fn(),
  openManager: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'profile.storage_breakdown.source.google_drive') return 'Google Drive';
      if (key === 'profile.storage_breakdown.source.github') return 'GitHub';
      return opts ? `${key} ${JSON.stringify(opts)}` : key;
    },
  }),
}));
vi.mock('@client/app/hooks/data/storageBreakdown', () => ({
  useGetStorageBreakdown: mockRefs.useGetStorageBreakdown,
}));
vi.mock('@client/app/stores/useDataLakeWizardStore', () => ({
  useDataLakeWizardStore: (selector: (s: { openManager: typeof mockRefs.openManager }) => unknown) =>
    selector({ openManager: mockRefs.openManager }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const MB = 1000 * 1000;
const bucket = (over: Partial<StorageBreakdownResponse['buckets'][number]>) => ({
  key: 'manual_upload',
  sourceType: FabFileSourceType.MANUAL_UPLOAD,
  bytes: 0,
  fileCount: 1,
  archivedBytes: 0,
  archivedFileCount: 0,
  ...over,
});

const scenario: StorageBreakdownResponse = {
  totalBytes: 965 * MB,
  accountedBytes: 960 * MB,
  unaccountedBytes: 5 * MB,
  buckets: [
    bucket({
      key: 'google_drive:lake-1',
      sourceType: FabFileSourceType.GOOGLE_DRIVE,
      lakeId: 'lake-1',
      lakeName: 'Sales Drive',
      bytes: 600 * MB,
      fileCount: 40,
    }),
    bucket({
      key: 'tool_generated:audio',
      sourceType: FabFileSourceType.TOOL_GENERATED,
      mediaKind: 'audio',
      bytes: 250 * MB,
      fileCount: 12,
      archivedBytes: 50 * MB,
      archivedFileCount: 2,
    }),
    bucket({ key: 'manual_upload', bytes: 100 * MB, fileCount: 30 }),
    bucket({
      key: 'github:lake-gone',
      sourceType: FabFileSourceType.GITHUB,
      lakeId: 'lake-gone',
      lakeName: null,
      bytes: 10 * MB,
    }),
  ],
};

const renderIt = () =>
  render(
    <TestWrapper>
      <StorageBreakdown />
    </TestWrapper>
  );

describe('StorageBreakdown', () => {
  beforeEach(() => {
    mockRefs.useGetStorageBreakdown.mockReset();
    mockRefs.openManager.mockReset();
    mockRefs.useGetStorageBreakdown.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  });

  it('does not fetch until opened', async () => {
    renderIt();
    expect(mockRefs.useGetStorageBreakdown).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.queryByTestId('storage-breakdown-row-manual_upload')).toBeNull();

    mockRefs.useGetStorageBreakdown.mockReturnValue({ data: scenario, isLoading: false, isError: false });
    await userEvent.click(screen.getByTestId('storage-breakdown-toggle-btn'));
    expect(mockRefs.useGetStorageBreakdown).toHaveBeenLastCalledWith({ enabled: true });
  });

  it('lists each bucket with its size, archived share, lake link and the unaccounted gap', async () => {
    mockRefs.useGetStorageBreakdown.mockReturnValue({ data: scenario, isLoading: false, isError: false });
    renderIt();
    await userEvent.click(screen.getByTestId('storage-breakdown-toggle-btn'));

    const lakeRow = screen.getByTestId('storage-breakdown-row-google_drive:lake-1');
    expect(within(lakeRow).getByText('Google Drive: Sales Drive')).toBeTruthy();
    expect(within(lakeRow).getByText('600 MB')).toBeTruthy();
    await userEvent.click(within(lakeRow).getByTestId('storage-breakdown-open-lake-lake-1'));
    expect(mockRefs.openManager).toHaveBeenCalledWith('mine', 'lake-1');

    const audioRow = screen.getByTestId('storage-breakdown-row-tool_generated:audio');
    expect(within(audioRow).getByText('profile.storage_breakdown.media.audio')).toBeTruthy();
    expect(within(audioRow).getByText('250 MB')).toBeTruthy();
    expect(screen.getByTestId('storage-breakdown-archived-tool_generated:audio').textContent).toContain('50 MB');

    const goneRow = screen.getByTestId('storage-breakdown-row-github:lake-gone');
    expect(within(goneRow).getByText(/unavailable_lake/)).toBeTruthy();
    expect(within(goneRow).queryByTestId('storage-breakdown-open-lake-lake-gone')).toBeNull();

    expect(within(screen.getByTestId('storage-breakdown-row-unaccounted')).getByText('5 MB')).toBeTruthy();
  });

  it('labels a counter below the counted files as such, without a minus sign', async () => {
    mockRefs.useGetStorageBreakdown.mockReturnValue({
      data: { ...scenario, totalBytes: 955 * MB, unaccountedBytes: -5 * MB },
      isLoading: false,
      isError: false,
    });
    renderIt();
    await userEvent.click(screen.getByTestId('storage-breakdown-toggle-btn'));

    const row = screen.getByTestId('storage-breakdown-row-unaccounted');
    expect(within(row).getByText('profile.storage_breakdown.overcounted')).toBeTruthy();
    expect(within(row).getByText('5 MB')).toBeTruthy();
    expect(within(row).queryByText('profile.storage_breakdown.unaccounted')).toBeNull();
  });

  it('offers a retry when the request fails', async () => {
    const refetch = vi.fn();
    mockRefs.useGetStorageBreakdown.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    renderIt();
    await userEvent.click(screen.getByTestId('storage-breakdown-toggle-btn'));
    await userEvent.click(screen.getByTestId('storage-breakdown-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });
});
