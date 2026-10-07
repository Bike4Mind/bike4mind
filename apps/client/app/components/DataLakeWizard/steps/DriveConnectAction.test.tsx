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
  onPicked: { current: null as null | ((folder: { driveFolderId: string; folderName?: string }) => void) },
  toastError: vi.fn(),
}));

vi.mock('@client/app/hooks/data/settings', () => ({ useConfig: () => ({ data: { googleClientId: 'gcid' } }) }));
vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useLakeDriveConnection: () => ({ data: h.connection.current, isLoading: false, isError: h.isError.current }),
  useConnectDriveFolderToLake: () => ({ mutate: h.connectMutate, isPending: false }),
  useDisconnectLakeDrive: () => ({ mutate: h.disconnectMutate, isPending: false }),
}));
vi.mock('react-google-drive-picker', () => ({ default: () => [h.openPicker] }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: h.toastError } }));
vi.mock('@client/app/hooks/data/useDriveFolderPicker', async importOriginal => {
  const actual = await importOriginal<typeof import('@client/app/hooks/data/useDriveFolderPicker')>();
  return {
    ...actual,
    useDriveFolderPicker: (args: Parameters<typeof actual.useDriveFolderPicker>[0]) => {
      h.onPicked.current = args.onPicked;
      return actual.useDriveFolderPicker(args);
    },
  };
});

import DriveConnectAction from './DriveConnectAction';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const connected = (over: Partial<LakeDriveConnection> = {}): LakeDriveConnection => ({
  id: 'c1',
  driveFolderId: 'FOLDER',
  folderName: 'Docs',
  status: 'connected',
  syncStale: false,
  enabled: true,
  lastError: null,
  lastUsedAt: null,
  connectedAt: null,
  fileCount: 3,
  disconnecting: false,
  disconnectStalled: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('google', { picker: {} }); // the Picker API counts as loaded
  h.connection.current = null;
  h.isError.current = false;
});

describe('DriveConnectAction', () => {
  it('offers an enabled Connect button when the lake has no connection yet', () => {
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('drive-connect-btn')).not.toBeDisabled();
  });

  it('says what the grant can read before the user reaches Google consent', () => {
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('drive-access-disclosure')).toHaveTextContent(/whole Google Drive/);
    expect(screen.getByTestId('drive-access-disclosure')).toHaveTextContent(/Only the folder you pick is ingested/);
  });

  it('drops the disclosure once a folder is connected', () => {
    h.connection.current = connected();
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.queryByTestId('drive-access-disclosure')).toBeNull();
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

  it('reports a healthy connection as Connected and shows no error line', () => {
    h.connection.current = connected();
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('drive-connection-status')).toHaveTextContent('Connected');
    expect(screen.queryByTestId('drive-connection-last-error')).toBeNull();
  });

  it('does NOT report a sync that stopped short as Connected (#2394)', () => {
    // releaseSyncClaim heals the status back to 'connected' whatever happened and records WHY on
    // lastError, so this pair is a sync that left files out of the lake. The old code showed a green
    // "Connected" chip here and rendered lastError only for status === 'credential_error', which is
    // exactly the "every dashboard says the sync worked" failure.
    h.connection.current = connected({
      lastError: 'Google Drive is rate-limiting this sync, and it stopped after 20 continuation runs.',
    });
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);

    const status = screen.getByTestId('drive-connection-status');
    expect(status).toHaveTextContent('Stopped short');
    expect(status).not.toHaveTextContent('Connected');
    expect(screen.getByTestId('drive-connection-last-error')).toHaveTextContent('rate-limiting');
  });

  it('requires a confirm step before disconnecting, so a single click is not destructive', () => {
    h.connection.current = connected();
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);

    fireEvent.click(screen.getByTestId('drive-disconnect-btn'));
    expect(h.disconnectMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('drive-disconnect-confirm-btn'));
    expect(h.disconnectMutate).toHaveBeenCalledWith('lake1', expect.any(Object));
  });

  it('warns how many files disconnecting will delete', () => {
    h.connection.current = connected({ fileCount: 42 });
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);

    fireEvent.click(screen.getByTestId('drive-disconnect-btn'));
    expect(screen.getByTestId('drive-disconnect-warning')).toHaveTextContent('42 files');
  });

  it('reads Disconnecting while the queued purge runs, with no Re-sync and no retry yet', () => {
    h.connection.current = connected({ disconnecting: true, fileCount: 7 });
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);

    expect(screen.getByTestId('drive-connection-status')).toHaveTextContent('Disconnecting');
    expect(screen.getByTestId('drive-disconnecting-note')).toHaveTextContent('7 remaining files');
    expect(screen.queryByTestId('drive-resync-btn')).toBeNull();
    // A retry now would only start a second purge chain over the same files.
    const button = screen.getByTestId('drive-disconnect-btn');
    expect(button).toHaveTextContent('Disconnecting');
    expect(button).toBeDisabled();
  });

  it('offers Retry disconnect once the purge looks stalled, so a DLQ-bound purge can be re-queued', () => {
    h.connection.current = connected({ disconnecting: true, disconnectStalled: true });
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);

    const button = screen.getByTestId('drive-disconnect-btn');
    expect(button).toHaveTextContent('Retry disconnect');
    expect(button).not.toBeDisabled();
  });

  it('says it is finishing up rather than removing 0 files', () => {
    h.connection.current = connected({ disconnecting: true, fileCount: 0 });
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('drive-disconnecting-note')).toHaveTextContent('Finishing disconnect...');
  });

  it('uses singular wording for exactly one file', () => {
    h.connection.current = connected({ fileCount: 1 });
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);

    fireEvent.click(screen.getByTestId('drive-disconnect-btn'));
    expect(screen.getByTestId('drive-disconnect-warning')).toHaveTextContent('1 file ');
  });

  it("toasts the server's reason when connecting a folder fails", () => {
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    h.onPicked.current?.({ driveFolderId: 'F1' });

    const [, options] = h.connectMutate.mock.calls[0];
    options.onError({ isAxiosError: true, response: { data: { error: 'Folder is claimed by another lake.' } } });
    expect(h.toastError).toHaveBeenCalledWith('Folder is claimed by another lake.');
  });

  it('falls back to generic copy when connecting a folder fails without a server reason', () => {
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    h.onPicked.current?.({ driveFolderId: 'F1' });

    const [, options] = h.connectMutate.mock.calls[0];
    options.onError(new Error('Network Error'));
    expect(h.toastError).toHaveBeenCalledWith('Could not connect that folder. Please try again.');
  });

  it("toasts the server's reason when disconnecting fails", () => {
    h.connection.current = connected();
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    fireEvent.click(screen.getByTestId('drive-disconnect-btn'));
    fireEvent.click(screen.getByTestId('drive-disconnect-confirm-btn'));

    const [, options] = h.disconnectMutate.mock.calls[0];
    options.onError({ isAxiosError: true, response: { data: { error: 'A sync is in progress.' } } });
    expect(h.toastError).toHaveBeenCalledWith('A sync is in progress.');
  });

  it('falls back to generic copy when disconnecting fails without a server reason', () => {
    h.connection.current = connected();
    wrap(<DriveConnectAction lake={{ id: 'lake1' }} />);
    fireEvent.click(screen.getByTestId('drive-disconnect-btn'));
    fireEvent.click(screen.getByTestId('drive-disconnect-confirm-btn'));

    const [, options] = h.disconnectMutate.mock.calls[0];
    options.onError(new Error('Network Error'));
    expect(h.toastError).toHaveBeenCalledWith('Could not disconnect. Please try again.');
  });
});
