import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { AxiosError, AxiosHeaders } from 'axios';
import { ACCOUNT_DELETION_PENDING_CODE } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  currentUser: null as Record<string, unknown> | null,
  status: null as Record<string, unknown> | null,
  setCurrentUser: vi.fn(),
  cancel: vi.fn(),
  logout: vi.fn(),
  api: null as unknown as import('axios').AxiosInstance,
}));

vi.mock('@client/app/contexts/ApiContext', async () => {
  const { default: realAxios } = await import('axios');
  h.api = realAxios.create();
  return { api: h.api };
});
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (select: (s: unknown) => unknown) =>
    select({ currentUser: h.currentUser, setCurrentUser: h.setCurrentUser }),
}));
vi.mock('@client/app/hooks/data/user', () => ({ useUserLogout: () => ({ mutate: h.logout, isPending: false }) }));
vi.mock('@client/app/hooks/data/accountDeletion', () => ({
  useAccountDeletionStatus: () => ({
    data: h.status,
    isSuccess: h.status !== null,
    isFetchedAfterMount: true,
    isFetching: false,
  }),
  useCancelAccountDeletion: () => ({ mutate: h.cancel, isPending: false }),
}));

import AccountDeletionPendingGate from './AccountDeletionPendingGate';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (exempt = false) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AccountDeletionPendingGate exempt={exempt}>
        <div data-testid="app-content" />
      </AccountDeletionPendingGate>
    </CssVarsProvider>
  );

describe('AccountDeletionPendingGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.currentUser = { id: 'u1' };
    h.status = null;
  });

  it('renders the app for an account with no pending deletion', () => {
    wrap();
    expect(screen.getByTestId('app-content')).toBeTruthy();
    expect(screen.queryByTestId('account-deletion-pending-screen')).toBeNull();
  });

  it('shows only the cancel screen, with the purge date, while a deletion is pending', () => {
    h.currentUser = { id: 'u1', deletion: { scheduledFor: '2026-11-17T12:00:00.000Z' } };
    wrap();
    expect(screen.queryByTestId('app-content')).toBeNull();
    expect(screen.getByTestId('account-deletion-date').textContent).toMatch(/2026/);
    fireEvent.click(screen.getByTestId('account-deletion-cancel-btn'));
    expect(h.cancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('account-deletion-sign-out-btn'));
    expect(h.logout).toHaveBeenCalledTimes(1);
  });

  it('shows irreversible cleanup and removes cancellation when the server reports purge start', () => {
    h.currentUser = { id: 'u1', deletion: { scheduledFor: '2026-11-17T12:00:00.000Z' } };
    h.status = { deletion: { scheduledFor: '2026-11-17T12:00:00.000Z', purgeStartedAt: '2026-11-17T12:01:00.000Z' } };
    wrap();
    expect(screen.getByText('Your account is being deleted')).toBeTruthy();
    expect(screen.queryByTestId('account-deletion-cancel-btn')).toBeNull();
    expect(screen.getByTestId('account-deletion-sign-out-btn')).toBeTruthy();
  });

  it('clears persisted deletion when another tab has cancelled it', () => {
    h.currentUser = { id: 'u1', deletion: { scheduledFor: '2026-11-17T12:00:00.000Z' } };
    h.status = { deletion: null };
    wrap();
    expect(h.setCurrentUser).toHaveBeenCalledWith({ id: 'u1', deletion: null });
  });

  it('renders an exempt page (the data export download) while a deletion is pending', () => {
    h.currentUser = { id: 'u1', deletion: { scheduledFor: '2026-11-17T12:00:00.000Z' } };
    wrap(true);
    expect(screen.getByTestId('app-content')).toBeTruthy();
    expect(screen.queryByTestId('account-deletion-pending-screen')).toBeNull();
  });

  it('switches to the cancel screen when an API answers 403 ACCOUNT_DELETION_PENDING', async () => {
    wrap();
    const response = {
      status: 403,
      statusText: 'Forbidden',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { code: ACCOUNT_DELETION_PENDING_CODE, scheduledFor: '2026-11-17T12:00:00.000Z' },
    };
    h.api.defaults.adapter = async config => {
      throw new AxiosError('Forbidden', 'ERR_BAD_REQUEST', config, null, { ...response, config });
    };
    await act(async () => {
      await h.api.get('/api/quests').catch(() => undefined);
    });
    expect(screen.queryByTestId('app-content')).toBeNull();
    expect(screen.getByTestId('account-deletion-pending-screen')).toBeTruthy();
  });
});
