import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AxiosError, type AxiosResponse } from 'axios';

const h = vi.hoisted(() => ({
  connectMutate: vi.fn(),
  openPicker: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  userId: 'user-1' as string | undefined,
}));

vi.mock('@client/app/hooks/data/settings', () => ({ useConfig: () => ({ data: { googleClientId: 'gcid' } }) }));
vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useConnectDriveFolderToLake: () => ({ mutate: h.connectMutate, isPending: false }),
}));
vi.mock('react-google-drive-picker', () => ({ default: () => [h.openPicker] }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get, post: h.post } }));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: { getState: () => ({ currentUser: h.userId ? { id: h.userId } : null }) },
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({ activeOrgId: () => 'org-1' }));

import { useLakeDriveFolderConnect } from './useLakeDriveFolderConnect';
import { consumeDriveConnectHandoff } from '@client/app/utils/driveConnectHandoff';

type PickerArgs = { callbackFunction: (pick: { action: string; docs?: { id: string; name?: string }[] }) => void };

beforeEach(() => {
  vi.clearAllMocks();
  h.userId = 'user-1';
  sessionStorage.clear();
  vi.stubGlobal('google', { picker: {} }); // the Picker API counts as loaded
});

describe('useLakeDriveFolderConnect', () => {
  it('connects the picked folder to the given lake and toasts the sync', async () => {
    h.get.mockResolvedValue({ data: { accessToken: 'tok' } });
    const { result } = renderHook(() => useLakeDriveFolderConnect('lake1'));

    await act(() => result.current.openFolderPicker());
    const { callbackFunction } = h.openPicker.mock.calls[0][0] as PickerArgs;
    act(() => callbackFunction({ action: 'picked', docs: [{ id: 'F1', name: 'Docs' }] }));

    expect(h.connectMutate).toHaveBeenCalledWith(
      { dataLakeId: 'lake1', driveFolderId: 'F1', folderName: 'Docs' },
      expect.any(Object)
    );
    h.connectMutate.mock.calls[0][1].onSuccess();
    expect(h.toastSuccess).toHaveBeenCalledWith('Syncing "Docs" into this data lake...');
  });

  it('toasts the server reason when the connect fails', async () => {
    h.get.mockResolvedValue({ data: { accessToken: 'tok' } });
    const { result } = renderHook(() => useLakeDriveFolderConnect('lake1'));

    await act(() => result.current.openFolderPicker());
    const { callbackFunction } = h.openPicker.mock.calls[0][0] as PickerArgs;
    act(() => callbackFunction({ action: 'picked', docs: [{ id: 'F1' }] }));
    h.connectMutate.mock.calls[0][1].onError(
      new AxiosError('Request failed with status code 409', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 409,
        data: { error: 'Folder is claimed.' },
      } as AxiosResponse)
    );

    expect(h.toastError).toHaveBeenCalledWith('Folder is claimed.');
  });

  it("sends a user with no linked Google account to Google's consent screen instead of the picker", async () => {
    const realLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } });
    h.get.mockRejectedValue({ response: { status: 400 } });
    h.post.mockResolvedValue({ data: { authUrl: 'https://accounts.google.com/o/oauth2/auth?x=1' } });
    try {
      const { result } = renderHook(() => useLakeDriveFolderConnect('lake1'));
      await act(() => result.current.openFolderPicker());

      expect(h.post).toHaveBeenCalledWith('/api/google-drive/connect');
      expect(window.location.href).toBe('https://accounts.google.com/o/oauth2/auth?x=1');
      expect(h.openPicker).not.toHaveBeenCalled();
      expect(h.connectMutate).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }
  });

  it('saves a return-to-this-lake handoff bound to the consent attempt before redirecting', async () => {
    const realLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } });
    h.get.mockRejectedValue({ response: { status: 400 } });
    h.post.mockResolvedValue({ data: { authUrl: 'https://accounts.google.com/o/oauth2/auth?state=s1' } });
    try {
      const { result } = renderHook(() => useLakeDriveFolderConnect('lake1'));
      await act(() => result.current.openFolderPicker());

      expect(window.location.href).toBe('https://accounts.google.com/o/oauth2/auth?state=s1');
      expect(consumeDriveConnectHandoff({ userId: 'user-1', organizationId: 'org-1', oauthState: 's1' })).toMatchObject(
        { kind: 'lake', dataLakeId: 'lake1' }
      );
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }
  });

  it('still redirects without a handoff when no user is signed in', async () => {
    const realLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } });
    h.userId = undefined;
    h.get.mockRejectedValue({ response: { status: 400 } });
    h.post.mockResolvedValue({ data: { authUrl: 'https://accounts.google.com/o/oauth2/auth?state=s1' } });
    try {
      const { result } = renderHook(() => useLakeDriveFolderConnect('lake1'));
      await act(() => result.current.openFolderPicker());

      expect(window.location.href).toBe('https://accounts.google.com/o/oauth2/auth?state=s1');
      expect(sessionStorage.getItem('b4m:drive-connect-handoff')).toBeNull();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }
  });
});
