import React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const JOB_ID = '7d0c1f5e-9a7b-4c1e-8f0a-2b3c4d5e6f70';
const state = vi.hoisted(() => ({
  download: {} as {
    isPending?: boolean;
    isError?: boolean;
    isFetching?: boolean;
    error?: unknown;
    data?: unknown;
    refetch?: () => Promise<unknown>;
  },
  useDownload: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useParams: () => ({ jobId: JOB_ID }) }));
vi.mock('@client/app/hooks/data/user', () => ({
  useAccountDataExportDownload: (jobId: string) => {
    state.useDownload(jobId);
    return state.download;
  },
}));

import AccountDataExportPage from './$jobId';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data: {} } });
const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AccountDataExportPage', () => {
  it('starts the download once the link arrives', () => {
    state.download = {
      data: {
        url: 'https://files.example.com/x.zip',
        filename: 'account-data-2026-03-01.zip',
        expiresAt: '2026-03-02T00:00:00Z',
      },
    };
    wrap(<AccountDataExportPage />);

    expect(state.useDownload).toHaveBeenCalledWith(JOB_ID);
    expect(assign).toHaveBeenCalledWith('https://files.example.com/x.zip');
  });

  it('fetches a fresh signed link when the fallback link is clicked', async () => {
    const refetch = vi.fn().mockResolvedValue({ data: { url: 'https://files.example.com/fresh.zip' } });
    state.download = {
      data: {
        url: 'https://files.example.com/x.zip',
        filename: 'account-data-2026-03-01.zip',
        expiresAt: '2026-03-02T00:00:00Z',
      },
      refetch,
    };
    wrap(<AccountDataExportPage />);
    assign.mockClear();

    fireEvent.click(screen.getByTestId('account-data-export-download-link'));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://files.example.com/fresh.zip'));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('says the export expired on a 410', () => {
    state.download = { isError: true, error: httpError(410) };
    wrap(<AccountDataExportPage />);
    expect(screen.getByTestId('account-data-export-error').textContent).toContain('expired');
    expect(assign).not.toHaveBeenCalled();
  });

  it('says the export was not found on a 404', () => {
    state.download = { isError: true, error: httpError(404) };
    wrap(<AccountDataExportPage />);
    expect(screen.getByTestId('account-data-export-error').textContent).toContain("couldn't find this export");
  });
});
