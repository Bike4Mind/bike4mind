import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const exportMutation = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const STEP_UP_CANCELLED = 'step-up cancelled';
vi.mock('@client/app/hooks/data/user', () => ({ useRequestAccountDataExport: () => exportMutation }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@client/app/utils/stepUpInterceptor', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/utils/stepUpInterceptor')>()),
  isStepUpCancelled: (error: unknown) => error instanceof Error && error.message === STEP_UP_CANCELLED,
}));

import DownloadAccountDataRow from './DownloadAccountDataRow';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

type ExportCallbacks = { onSuccess?: () => void; onError?: (error: unknown) => void };
const requestExport = (outcome: (callbacks: ExportCallbacks) => void) => {
  exportMutation.mutate.mockImplementation((_vars: unknown, callbacks: ExportCallbacks) => outcome(callbacks));
  wrap(<DownloadAccountDataRow />);
  fireEvent.click(screen.getByTestId('settings-data-export-btn'));
};

beforeEach(() => {
  exportMutation.mutate.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('DownloadAccountDataRow', () => {
  it('tells the user the link will arrive by email', () => {
    requestExport(({ onSuccess }) => onSuccess?.());
    expect(exportMutation.mutate).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('email you a download link'));
  });

  it('explains the hourly limit on a 429', () => {
    const tooMany = Object.assign(new Error('Too many requests'), {
      isAxiosError: true,
      response: { status: 429, data: {} },
    });
    requestExport(({ onError }) => onError?.(tooMany));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('one data export per hour'));
  });

  it('stays silent when the identity check is cancelled', () => {
    requestExport(({ onError }) => onError?.(new Error(STEP_UP_CANCELLED)));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
