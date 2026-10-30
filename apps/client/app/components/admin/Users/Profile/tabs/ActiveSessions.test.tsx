import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildProfile, ProfileTestWrapper } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.get, post: mocks.post, delete: mocks.delete },
}));
vi.mock('./SupportAccessHistory', () => ({ SupportAccessHistory: () => null }));

import { ActiveSessions, sessionDevice } from './ActiveSessions';

const SESSIONS = [
  {
    sid: 'sid-1',
    createdVia: 'oauth',
    device: { browser: 'Chrome', os: 'macOS', ip: '198.51.100.4', location: 'Lisbon, PT' },
    lastUsedAt: '2026-10-20T09:00:00.000Z',
    createdAt: '2026-10-01T09:00:00.000Z',
    expiresAt: '2026-11-01T09:00:00.000Z',
    impersonated: false,
    current: false,
  },
  {
    sid: 'sid-2',
    createdVia: 'impersonation',
    lastUsedAt: '2026-10-19T09:00:00.000Z',
    createdAt: '2026-10-19T08:00:00.000Z',
    expiresAt: '2026-10-20T08:00:00.000Z',
    impersonated: true,
    current: false,
  },
];

const renderSessions = () =>
  render(<ActiveSessions user={buildProfile({ name: 'Ada Lovelace' })} />, { wrapper: ProfileTestWrapper });

const pickReasonAndConfirm = () => {
  fireEvent.click(screen.getByTestId('user-sessions-revoke-dialog-reason-input-preset-0'));
  fireEvent.click(screen.getByTestId('user-sessions-revoke-dialog-confirm-btn'));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: { items: SESSIONS } });
  mocks.post.mockResolvedValue({ data: {} });
  mocks.delete.mockResolvedValue({ data: {} });
});

describe('ActiveSessions', () => {
  it('describes a device by browser and OS, or a dash', () => {
    expect(sessionDevice(SESSIONS[0])).toBe('Chrome on macOS');
    expect(sessionDevice({ device: undefined })).toBe('-');
  });

  it('parses the user agent when the session stores no browser or OS', () => {
    const userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    expect(sessionDevice({ device: { userAgent } })).toBe('Chrome on macOS');
    expect(sessionDevice({ device: { userAgent: 'curl/8.0' } })).toBe('-');
  });

  it('lists each active session with method, device, IP and location', async () => {
    renderSessions();

    const rows = await screen.findAllByTestId('user-sessions-row');
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/users/test-user-1/sessions');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Social sign-in');
    expect(rows[0]).toHaveTextContent('Chrome on macOS');
    expect(rows[0]).toHaveTextContent('198.51.100.4');
    expect(rows[0]).toHaveTextContent('Lisbon, PT');
    expect(rows[1]).toHaveTextContent('Admin sign-in as user');
  });

  it('signs out one session with the reason after confirming', async () => {
    renderSessions();
    const rows = await screen.findAllByTestId('user-sessions-row');

    fireEvent.click(within(rows[0]).getByTestId('user-sessions-revoke-btn'));
    expect(screen.getByTestId('user-sessions-revoke-dialog-confirm-btn')).toBeDisabled();
    pickReasonAndConfirm();

    await waitFor(() =>
      expect(mocks.delete).toHaveBeenCalledWith('/api/admin/users/test-user-1/sessions', {
        params: { sid: 'sid-1' },
        data: { reason: 'Compromised account' },
      })
    );
    expect(mocks.post).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('user-sessions-revoke-dialog-confirm-btn')).toBeNull());
  });

  it('signs out everywhere through the force-logout route', async () => {
    renderSessions();
    await screen.findAllByTestId('user-sessions-row');

    fireEvent.click(screen.getByTestId('user-sessions-revoke-all-btn'));
    expect(screen.getByText('Sign Ada Lovelace out everywhere?')).toBeInTheDocument();
    pickReasonAndConfirm();

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/users/test-user-1/revoke-sessions', {
        reason: 'Compromised account',
      })
    );
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('names an unrecognised device neutrally in the sign-out dialog', async () => {
    mocks.get.mockResolvedValue({ data: { items: [{ ...SESSIONS[0], device: { ip: '198.51.100.4' } }] } });
    renderSessions();
    const rows = await screen.findAllByTestId('user-sessions-row');

    fireEvent.click(within(rows[0]).getByTestId('user-sessions-revoke-btn'));
    expect(screen.getByText(/^This session will need to sign in again\./)).toBeInTheDocument();
  });

  it('keeps the dialog open when the revoke fails', async () => {
    mocks.delete.mockRejectedValue(new Error('boom'));
    renderSessions();
    const rows = await screen.findAllByTestId('user-sessions-row');

    fireEvent.click(within(rows[0]).getByTestId('user-sessions-revoke-btn'));
    pickReasonAndConfirm();

    await waitFor(() => expect(mocks.delete).toHaveBeenCalled());
    expect(screen.getByTestId('user-sessions-revoke-dialog-confirm-btn')).toBeInTheDocument();
  });

  it('keeps the dialog open when signing out everywhere fails', async () => {
    mocks.post.mockRejectedValue(new Error('boom'));
    renderSessions();
    await screen.findAllByTestId('user-sessions-row');

    fireEvent.click(screen.getByTestId('user-sessions-revoke-all-btn'));
    pickReasonAndConfirm();

    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    expect(screen.getByTestId('user-sessions-revoke-dialog-confirm-btn')).toBeInTheDocument();
  });

  it('says so when the sessions cannot be loaded', async () => {
    mocks.get.mockRejectedValue(new Error('boom'));
    renderSessions();
    expect(await screen.findByText('Sessions could not be loaded.')).toBeInTheDocument();
  });

  it("offers no sign-out on the admin's own current session", async () => {
    mocks.get.mockResolvedValue({ data: { items: [{ ...SESSIONS[0], current: true }, SESSIONS[1]] } });
    renderSessions();
    const rows = await screen.findAllByTestId('user-sessions-row');

    expect(within(rows[0]).queryByTestId('user-sessions-revoke-btn')).toBeNull();
    expect(within(rows[0]).getByTestId('user-sessions-current-label')).toHaveTextContent('This session');
    expect(within(rows[1]).getByTestId('user-sessions-revoke-btn')).toBeInTheDocument();
  });

  it('says so when there are no active sessions', async () => {
    mocks.get.mockResolvedValue({ data: { items: [] } });
    renderSessions();
    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });
});
