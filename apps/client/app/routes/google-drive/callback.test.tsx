import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  startConnect: vi.fn(),
  toastError: vi.fn(),
  userId: 'user-1' as string | undefined,
  orgId: 'org-1' as string | undefined,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.apiGet } }));
vi.mock('@client/app/hooks/data/googleDrive', () => ({ startGoogleDriveConnect: h.startConnect }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
  useSearch: () => h.search,
}));
vi.mock('sonner', () => ({ toast: { error: h.toastError } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: { getState: () => ({ currentUser: h.userId ? { id: h.userId } : null }) },
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({ activeOrgId: () => h.orgId }));

import GoogleDriveCallbackPage from './callback';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { saveDriveConnectHandoff, takeDrivePickerResume } from '@client/app/utils/driveConnectHandoff';

const saveWizardDraft = (authUrl = 'https://accounts.google.com/auth?state=signed-state') =>
  saveDriveConnectHandoff(
    {
      kind: 'createWizard',
      userId: 'user-1',
      organizationId: 'org-1',
      config: {
        name: 'Research',
        description: '',
        tagPrefix: 'research',
        requiredUserTag: '',
        requiredEntitlement: '',
        conflictResolution: 'skip',
      },
      autoDerivedTagPrefix: 'research',
      optionalSteps: { preview: true, taxonomy: false },
    },
    authUrl
  );

const rejectWithCode = (code: string) => {
  const headers = new AxiosHeaders();
  const error = new AxiosError('Bad Request', 'ERR_BAD_REQUEST', { headers }, undefined, {
    status: 400,
    statusText: 'Bad Request',
    data: { code },
    headers: {},
    config: { headers },
  });
  h.apiGet.mockRejectedValue(error);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.search = { code: 'auth-code', state: 'signed-state' };
  h.startConnect.mockResolvedValue(undefined);
  h.userId = 'user-1';
  h.orgId = 'org-1';
  sessionStorage.clear();
  takeDrivePickerResume();
  useDataLakeWizardStore.getState().resetWizard();
  useDataLakeWizardStore.getState().closeManager();
});

describe('GoogleDriveCallbackPage', () => {
  it('tells the user an expired attempt expired and offers to connect again', async () => {
    rejectWithCode('GOOGLE_DRIVE_CONNECT_EXPIRED');

    render(<GoogleDriveCallbackPage />);

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(h.toastError).toHaveBeenCalledWith(
      'That Google Drive connection attempt expired. Please connect again.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Connect again' }) })
    );

    const [, options] = h.toastError.mock.calls[0];
    options.action.onClick();
    expect(h.startConnect).toHaveBeenCalledTimes(1);
  });

  it('offers to connect again when the attempt is no longer valid', async () => {
    rejectWithCode('GOOGLE_DRIVE_CONNECT_INVALID');

    render(<GoogleDriveCallbackPage />);

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(h.toastError).toHaveBeenCalledWith(
      'That Google Drive connection attempt is no longer valid. Please connect again.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Connect again' }) })
    );
  });

  it('offers to connect again when Google rejects the token exchange', async () => {
    rejectWithCode('GOOGLE_DRIVE_CONNECT_FAILED');

    render(<GoogleDriveCallbackPage />);

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(h.toastError).toHaveBeenCalledWith(
      'Google Drive could not complete the connection. Please connect again.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Connect again' }) })
    );
  });

  it('completes the connection and goes home without a toast', async () => {
    h.apiGet.mockResolvedValue({ data: undefined });

    render(<GoogleDriveCallbackPage />);

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(h.apiGet).toHaveBeenCalledWith('/api/google-drive/callback?code=auth-code&state=signed-state');
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('falls back to the generic error for an uncoded failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.apiGet.mockRejectedValue(new Error('network down'));

    render(<GoogleDriveCallbackPage />);

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(h.toastError).toHaveBeenCalledWith('Error connecting to Google Drive');
  });

  it('falls back to the generic error when restarting the connection fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rejectWithCode('GOOGLE_DRIVE_CONNECT_EXPIRED');
    h.startConnect.mockRejectedValue(new Error('popup blocked'));

    render(<GoogleDriveCallbackPage />);

    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    const [, options] = h.toastError.mock.calls[0];
    options.action.onClick();

    await waitFor(() => expect(h.toastError).toHaveBeenLastCalledWith('Error connecting to Google Drive'));
    expect(consoleError).toHaveBeenCalled();
  });

  it('encodes code and state into the API request', async () => {
    h.search = { code: 'a/b+c', state: 'x&y=z' };
    h.apiGet.mockResolvedValue({ data: undefined });

    render(<GoogleDriveCallbackPage />);

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(h.apiGet).toHaveBeenCalledWith('/api/google-drive/callback?code=a%2Fb%2Bc&state=x%26y%3Dz');
  });

  it('shows the generic error without calling the API when a param is missing', async () => {
    h.search = { code: 'auth-code' };

    render(<GoogleDriveCallbackPage />);

    expect(h.apiGet).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith('Error connecting to Google Drive');
    expect(h.navigate).toHaveBeenCalledWith({ to: '/' });
  });

  it('does not call the API when consent was denied', async () => {
    h.search = { error: 'access_denied' };

    render(<GoogleDriveCallbackPage />);

    expect(h.apiGet).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith('Google Drive connection cancelled.');
    expect(h.navigate).toHaveBeenCalledWith({ to: '/' });
  });

  describe('resuming the Create wizard', () => {
    it('reopens the wizard with the saved config and asks for the folder picker', async () => {
      saveWizardDraft();
      h.apiGet.mockResolvedValue({ data: undefined });

      render(<GoogleDriveCallbackPage />);

      await waitFor(() => expect(useDataLakeWizardStore.getState().isOpen).toBe(true));
      const wizard = useDataLakeWizardStore.getState();
      expect(wizard.step).toBe('source');
      expect(wizard.config.name).toBe('Research');
      expect(wizard.config.tagPrefix).toBe('research');
      expect(wizard.optionalSteps).toEqual({ preview: true, taxonomy: false });
      expect(takeDrivePickerResume('user-1')).toBe(true);
      expect(sessionStorage.getItem('b4m:drive-connect-handoff')).toBeNull();
      expect(h.navigate).toHaveBeenCalledWith({ to: '/' });
    });

    it('does not resume when the connect failed, and leaves the draft for its own attempt', async () => {
      saveWizardDraft();
      rejectWithCode('GOOGLE_DRIVE_CONNECT_EXPIRED');

      render(<GoogleDriveCallbackPage />);

      await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: '/' }));
      expect(useDataLakeWizardStore.getState().isOpen).toBe(false);
      expect(takeDrivePickerResume('user-1')).toBe(false);
    });

    it('does not resume when consent was cancelled', async () => {
      saveWizardDraft();
      h.search = { error: 'access_denied' };

      render(<GoogleDriveCallbackPage />);

      expect(useDataLakeWizardStore.getState().isOpen).toBe(false);
      expect(takeDrivePickerResume('user-1')).toBe(false);
    });

    it.each([
      ['another OAuth attempt', () => saveWizardDraft('https://accounts.google.com/auth?state=older-state')],
      ['another user', () => ((h.userId = 'user-2'), saveWizardDraft())],
      ['another account scope', () => ((h.orgId = undefined), saveWizardDraft())],
      ['no signed-in user', () => ((h.userId = undefined), saveWizardDraft())],
    ])('ignores a draft saved for %s', async (_label, arrange) => {
      arrange();
      h.apiGet.mockResolvedValue({ data: undefined });

      render(<GoogleDriveCallbackPage />);

      await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: '/' }));
      expect(useDataLakeWizardStore.getState().isOpen).toBe(false);
      expect(takeDrivePickerResume('user-1')).toBe(false);
    });
  });

  describe('connecting again after a failed attempt', () => {
    const RETRY_URL = 'https://accounts.google.com/auth?state=retry-state';

    const failThenRetry = async () => {
      rejectWithCode('GOOGLE_DRIVE_CONNECT_EXPIRED');
      h.startConnect.mockImplementation(async (onBeforeRedirect?: (authUrl: string) => void) => {
        onBeforeRedirect?.(RETRY_URL);
      });
      const { unmount } = render(<GoogleDriveCallbackPage />);
      await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
      const [, options] = h.toastError.mock.calls[0];
      options.action.onClick();
      await waitFor(() => expect(h.startConnect).toHaveBeenCalledTimes(1));
      unmount();
    };

    const completeRetry = async () => {
      h.search = { code: 'retry-code', state: 'retry-state' };
      h.apiGet.mockReset().mockResolvedValue({ data: undefined });
      h.navigate.mockClear();
      render(<GoogleDriveCallbackPage />);
      await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: '/' }));
    };

    it('resumes the wizard when the retry completes', async () => {
      saveWizardDraft();
      await failThenRetry();
      await completeRetry();

      expect(useDataLakeWizardStore.getState().isOpen).toBe(true);
      expect(useDataLakeWizardStore.getState().config.name).toBe('Research');
      expect(takeDrivePickerResume('user-1')).toBe(true);
    });

    it('does not carry over a draft saved for a different attempt', async () => {
      saveWizardDraft('https://accounts.google.com/auth?state=older-state');
      await failThenRetry();
      await completeRetry();

      expect(useDataLakeWizardStore.getState().isOpen).toBe(false);
      expect(takeDrivePickerResume('user-1')).toBe(false);
    });

    it('does not carry the draft over to another signed-in user', async () => {
      saveWizardDraft();
      h.userId = 'user-2';
      await failThenRetry();
      h.userId = 'user-1';
      await completeRetry();

      expect(useDataLakeWizardStore.getState().isOpen).toBe(false);
    });
  });

  describe('returning to an existing lake', () => {
    const saveLakeHandoff = () =>
      saveDriveConnectHandoff(
        { kind: 'lake', userId: 'user-1', organizationId: 'org-1', dataLakeId: 'lake-7' },
        'https://accounts.google.com/auth?state=signed-state'
      );

    it('reopens that lake in the manager without touching the Create wizard', async () => {
      saveLakeHandoff();
      h.apiGet.mockResolvedValue({ data: undefined });

      render(<GoogleDriveCallbackPage />);

      await waitFor(() => expect(useDataLakeWizardStore.getState().isManagerOpen).toBe(true));
      const store = useDataLakeWizardStore.getState();
      expect(store.managerTab).toBe('mine');
      expect(store.managerLakeId).toBe('lake-7');
      expect(store.isOpen).toBe(false);
      expect(takeDrivePickerResume('user-1')).toBe(false);
      expect(sessionStorage.getItem('b4m:drive-connect-handoff')).toBeNull();
    });

    it('does not reopen the lake when the connect failed', async () => {
      saveLakeHandoff();
      rejectWithCode('GOOGLE_DRIVE_CONNECT_EXPIRED');

      render(<GoogleDriveCallbackPage />);

      await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: '/' }));
      expect(useDataLakeWizardStore.getState().isManagerOpen).toBe(false);
    });
  });
});
