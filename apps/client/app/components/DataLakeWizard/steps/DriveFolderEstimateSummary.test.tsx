import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useUser } from '@client/app/contexts/UserContext';
import type { IUserDocument } from '@bike4mind/common';
import DriveFolderEstimateSummary from './DriveFolderEstimateSummary';

const query = vi.hoisted(() => ({
  current: { data: undefined, isLoading: false, isError: false } as {
    data?: Record<string, unknown>;
    isLoading: boolean;
    isError: boolean;
  },
}));
vi.mock('@client/app/hooks/data/useDriveFolderEstimate', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/useDriveFolderEstimate')>()),
  useDriveFolderEstimate: () => query.current,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const loaded = (over: Record<string, unknown> = {}) => ({
  data: {
    folderId: 'F1',
    fileCount: 12,
    knownBytes: 3_000_000,
    unknownSizeCount: 0,
    overSizeLimitCount: 0,
    unsupportedCount: 0,
    truncated: false,
    overCandidateCap: false,
    maxFileSizeBytes: 100 * 1024 * 1024,
    candidateCap: 20000,
    ...over,
  },
  isLoading: false,
  isError: false,
});

const renderSummary = () => render(<DriveFolderEstimateSummary driveFolderId="F1" />, { wrapper: TestWrapper });

describe('DriveFolderEstimateSummary', () => {
  afterEach(() => useUser.setState({ currentUser: null }));

  it('shows a loading line while the folder is being walked', () => {
    query.current = { data: undefined, isLoading: true, isError: false };
    renderSummary();
    expect(screen.getByTestId('drive-estimate-loading')).toHaveTextContent('Estimating Drive folder...');
  });

  it('shows the file count, known bytes, unknown-size count and what will not be imported', () => {
    query.current = loaded({ unknownSizeCount: 4, overSizeLimitCount: 2, unsupportedCount: 1 });
    renderSummary();
    expect(screen.getByTestId('drive-estimate-summary')).toHaveTextContent(
      'Drive folder: 12 files, at least 3 MB (plus 4 Google files of unknown size)'
    );
    expect(screen.getByTestId('drive-estimate-skipped')).toHaveTextContent(
      'Not imported: 2 over the per-file size limit, 1 of unsupported types.'
    );
    // No known quota: never warns.
    expect(screen.queryByTestId('drive-estimate-worst-case-warning')).toBeNull();
  });

  it('omits the skipped line when nothing is skipped', () => {
    query.current = loaded();
    renderSummary();
    expect(screen.getByTestId('drive-estimate-summary')).not.toHaveTextContent('unknown size');
    expect(screen.queryByTestId('drive-estimate-skipped')).toBeNull();
  });

  it('flags a folder over the per-sync file cap with the worker wording', () => {
    query.current = loaded({ fileCount: 20001, truncated: true, overCandidateCap: true });
    renderSummary();
    expect(screen.getByTestId('drive-estimate-over-cap')).toHaveTextContent(
      'Split it into subfolders and connect them separately.'
    );
  });

  it.each([
    ['a truncated walk', loaded({ truncated: true, truncatedReason: 'deadline' })],
    ['a failed estimate', { data: undefined, isLoading: false, isError: true }],
  ])('says it could not estimate for %s', (_label, state) => {
    query.current = state;
    renderSummary();
    expect(screen.getByTestId('drive-estimate-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('drive-estimate-summary')).toBeNull();
  });

  it('warns when only the unknown-size worst case would exceed the storage limit', () => {
    // 10 MB limit; 3 MB known fits, 3 MB + one 10 MiB export does not.
    useUser.setState({ currentUser: { currentStorageSize: 0, storageLimit: 10 } as IUserDocument });
    query.current = loaded({ unknownSizeCount: 1 });
    renderSummary();
    expect(screen.getByTestId('drive-estimate-worst-case-warning')).toBeInTheDocument();
  });

  it('warns a user already over quota whose folder has only unknown-size files', () => {
    // The modal does not block a commit with no known bytes, so this warning is the only signal.
    useUser.setState({ currentUser: { currentStorageSize: 20_000_000, storageLimit: 10 } as IUserDocument });
    query.current = loaded({ knownBytes: 0, unknownSizeCount: 3 });
    renderSummary();
    expect(screen.getByTestId('drive-estimate-worst-case-warning')).toBeInTheDocument();
  });

  it('does not warn a user already over quota whose folder brings no importable files', () => {
    useUser.setState({ currentUser: { currentStorageSize: 20_000_000, storageLimit: 10 } as IUserDocument });
    query.current = loaded({ knownBytes: 0, unknownSizeCount: 0, unsupportedCount: 3 });
    renderSummary();
    expect(screen.queryByTestId('drive-estimate-worst-case-warning')).toBeNull();
  });

  it('does not warn when the known bytes already exceed (the modal blocks instead)', () => {
    useUser.setState({ currentUser: { currentStorageSize: 0, storageLimit: 1 } as IUserDocument });
    query.current = loaded({ unknownSizeCount: 1 });
    renderSummary();
    expect(screen.queryByTestId('drive-estimate-worst-case-warning')).toBeNull();
  });

  it('does not warn when the worst case fits', () => {
    useUser.setState({ currentUser: { currentStorageSize: 0, storageLimit: 100 } as IUserDocument });
    query.current = loaded({ unknownSizeCount: 1 });
    renderSummary();
    expect(screen.queryByTestId('drive-estimate-worst-case-warning')).toBeNull();
  });
});
