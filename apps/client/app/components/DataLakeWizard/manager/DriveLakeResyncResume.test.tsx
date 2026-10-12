import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { LakeDriveConnection } from '@client/app/hooks/data/googleDrive';

const h = vi.hoisted(() => ({
  connection: { current: null as Partial<LakeDriveConnection> | null },
  canManage: { current: true },
  resync: vi.fn(),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: { getState: () => ({ currentUser: { id: 'user-1' } }) },
}));
vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useLakeDriveConnection: () => ({ data: h.connection.current }),
  useLakeDriveCanManage: () => ({ data: h.canManage.current }),
}));
vi.mock('@client/app/hooks/data/useLakeDriveFolderConnect', () => ({
  useLakeDriveFolderConnect: () => ({ resync: h.resync }),
}));

import DriveLakeResyncResume from './DriveLakeResyncResume';
import { requestDriveLakeResyncResume, takeDriveLakeResyncResume } from '@client/app/utils/driveConnectHandoff';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  takeDriveLakeResyncResume();
  h.connection.current = { driveFolderId: 'FOLDER', folderName: 'Docs', disconnecting: false };
  h.canManage.current = true;
});

describe('DriveLakeResyncResume', () => {
  it('re-syncs the bound folder once when the manager opens on a lake the callback flagged', async () => {
    requestDriveLakeResyncResume('user-1', 'lake-1');
    const { rerender } = render(<DriveLakeResyncResume />);

    await waitFor(() => expect(h.resync).toHaveBeenCalledWith({ driveFolderId: 'FOLDER', folderName: 'Docs' }));
    rerender(<DriveLakeResyncResume />);
    await flush();
    expect(h.resync).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a pending signal', async () => {
    render(<DriveLakeResyncResume />);
    await flush();
    expect(h.resync).not.toHaveBeenCalled();
  });

  it.each([
    ['the caller cannot manage the connection', () => (h.canManage.current = false)],
    [
      'the folder is being disconnected',
      () => (h.connection.current = { ...h.connection.current, disconnecting: true }),
    ],
    ['the lake has no connection', () => (h.connection.current = null)],
  ])('does not sync when %s', async (_label, arrange) => {
    arrange();
    requestDriveLakeResyncResume('user-1', 'lake-1');
    render(<DriveLakeResyncResume />);
    await flush();
    expect(h.resync).not.toHaveBeenCalled();
  });
});
