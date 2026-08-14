import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { LakeAccessView } from '@bike4mind/common';
import { DataLakeAccessModal } from './DataLakeAccessModal';

const downloadCsv = vi.fn();
let viewState: { data?: LakeAccessView; isLoading: boolean; isError: boolean; error?: unknown };

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useLakeAccessView: () => viewState,
  downloadLakeAccessCsv: (...args: unknown[]) => downloadCsv(...args),
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const fullView: LakeAccessView = {
  lakeId: 'lake1',
  lakeName: 'Sales Intelligence',
  grants: [
    {
      principalType: 'user',
      principalId: 'u2',
      principalName: 'Bob',
      role: 'reader',
      grantedByUserId: 'u1',
      grantedByName: 'Alice',
      grantedAt: new Date('2026-08-01T00:00:00.000Z'),
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      status: 'expired',
    },
  ],
  channels: [
    { kind: 'tag', value: 'vip' },
    { kind: 'organization', value: 'orgA', label: 'Acme', holderCount: 3 },
  ],
  history: [
    {
      principalKind: 'user',
      principalId: 'u2',
      principalName: 'Bob',
      readCount: 7,
      firstAccessedAt: new Date('2026-08-01T00:00:00.000Z'),
      lastAccessedAt: new Date('2026-08-10T00:00:00.000Z'),
      surfaces: ['chat-kb-search'],
    },
  ],
  historyTruncated: true,
  generatedAt: new Date('2026-08-14T12:00:00.000Z'),
};

const lake = { id: 'lake1', name: 'Sales Intelligence' };

beforeEach(() => {
  vi.clearAllMocks();
  viewState = { data: fullView, isLoading: false, isError: false };
});

describe('DataLakeAccessModal', () => {
  it('is closed when no lake is passed', () => {
    render(<DataLakeAccessModal lake={null} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('datalake-access-modal')).not.toBeInTheDocument();
  });

  it('renders grants, channels and history with the expired grant flagged', () => {
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-grants-table')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-access-grant-status-expired')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-access-channel-tag')).toHaveTextContent('vip');
    expect(screen.getByTestId('datalake-access-channel-organization')).toHaveTextContent('Acme (3 members)');
    expect(screen.getByTestId('datalake-access-history-table')).toBeInTheDocument();
  });

  it('warns when the history was truncated', () => {
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-history-truncated')).toBeInTheDocument();
  });

  it('exports the CSV via the download helper', async () => {
    downloadCsv.mockResolvedValue(undefined);
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-export-btn'));
    expect(downloadCsv).toHaveBeenCalledWith('lake1');
  });

  it('toasts when the export fails', async () => {
    downloadCsv.mockRejectedValue(new Error('boom'));
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-export-btn'));
    expect(toastError).toHaveBeenCalled();
  });

  it('shows the manager-only message on a 403', () => {
    viewState = { isLoading: false, isError: true, error: { response: { status: 403 } } };
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-error')).toHaveTextContent(/manage this data lake/i);
  });

  it('renders empty states when there are no grants, channels, or reads', () => {
    viewState = {
      isLoading: false,
      isError: false,
      data: { ...fullView, grants: [], channels: [], history: [], historyTruncated: false },
    };
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-grants-empty')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-access-channels-empty')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-access-history-empty')).toBeInTheDocument();
  });
});
