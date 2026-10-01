import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  startConnect: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.apiGet } }));
vi.mock('@client/app/hooks/data/googleDrive', () => ({ startGoogleDriveConnect: h.startConnect }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
  useSearch: () => h.search,
}));
vi.mock('sonner', () => ({ toast: { error: h.toastError } }));

import GoogleDriveCallbackPage from './callback';

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

  it('falls back to the generic error for an uncoded failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.apiGet.mockRejectedValue(new Error('network down'));

    render(<GoogleDriveCallbackPage />);

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(h.toastError).toHaveBeenCalledWith('Error connecting to Google Drive');
  });

  it('does not call the API when consent was denied', async () => {
    h.search = { error: 'access_denied' };

    render(<GoogleDriveCallbackPage />);

    expect(h.apiGet).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith('Google Drive connection cancelled.');
    expect(h.navigate).toHaveBeenCalledWith({ to: '/' });
  });
});
