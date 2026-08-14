import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { LakeDriveConnection } from '@client/app/hooks/data/googleDrive';

const h = vi.hoisted(() => ({
  connection: { current: null as LakeDriveConnection | null },
  isError: { current: false },
  connectMutate: vi.fn(),
  disconnectMutate: vi.fn(),
  openPicker: vi.fn(),
}));

vi.mock('@client/app/hooks/data/settings', () => ({ useConfig: () => ({ data: { googleClientId: 'gcid' } }) }));
vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useLakeDriveConnection: () => ({ data: h.connection.current, isLoading: false, isError: h.isError.current }),
  useConnectDriveFolderToLake: () => ({ mutate: h.connectMutate, isPending: false }),
  useDisconnectLakeDrive: () => ({ mutate: h.disconnectMutate, isPending: false }),
}));
vi.mock('react-google-drive-picker', () => ({ default: () => [h.openPicker] }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import DriveConnectAction from './DriveConnectAction';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const connected = (over: Partial<LakeDriveConnection> = {}): LakeDriveConnection => ({
  id: 'c1',
  driveFolderId: 'FOLDER',
  folderName: 'Docs',
  status: 'connected',
  enabled: true,
  lastError: null,
  lastUsedAt: null,
  connectedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.connection.current = null;
  h.isError.current = false;
});

describe('DriveConnectAction', () => {
  it('disables the action in create mode, before the lake exists', () => {
    wrap(<DriveConnectAction lake={null} />);
    expect(screen.getByTestId('drive-connect-disabled-btn')).toBeDisabled();
  });

  it('offers an enabled Connect button when the lake has no connection yet', () => {
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('drive-connect-btn')).not.toBeDisabled();
  });

  it('disables the action when the status query errors (personal lake / non-manager)', () => {
    // A 403/404 from the status endpoint must not render an enabled button that can only ever fail.
    h.isError.current = true;
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('drive-connect-unavailable-btn')).toBeDisabled();
    expect(screen.queryByTestId('drive-connect-btn')).toBeNull();
  });

  it('shows the connected folder with re-sync and disconnect', () => {
    h.connection.current = connected();
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('drive-connection-status')).toHaveTextContent('Docs');
    expect(screen.getByTestId('drive-resync-btn')).toBeInTheDocument();
    expect(screen.getByTestId('drive-disconnect-btn')).toBeInTheDocument();
  });

  it('requires a confirm step before disconnecting, so a single click is not destructive', () => {
    h.connection.current = connected();
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);

    fireEvent.click(screen.getByTestId('drive-disconnect-btn'));
    expect(h.disconnectMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('drive-disconnect-confirm-btn'));
    expect(h.disconnectMutate).toHaveBeenCalledWith('lake1', expect.any(Object));
  });
});
