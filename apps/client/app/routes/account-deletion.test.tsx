import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const state = vi.hoisted(() => ({
  currentUser: null as { deletionRequestedAt?: string | null } | null,
  accessToken: 'token' as string | null,
  navigate: vi.fn(),
  restore: { mutate: vi.fn(), isPending: false, isError: false, error: null },
  logout: { mutate: vi.fn(), isPending: false },
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: state.currentUser }) }));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (select: (s: { accessToken: string | null }) => unknown) =>
    select({ accessToken: state.accessToken }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useRestoreAccountDeletion: () => state.restore,
  useUserLogout: () => state.logout,
}));

import AccountDeletionPage from './account-deletion';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  state.accessToken = 'token';
  state.currentUser = { deletionRequestedAt: '2026-03-01T12:00:00.000Z' };
});

describe('AccountDeletionPage', () => {
  it('restores the account and goes home', () => {
    wrap(<AccountDeletionPage />);
    expect(screen.getByTestId('account-deletion-scheduled-for').textContent).toContain('2026');

    fireEvent.click(screen.getByTestId('account-deletion-restore-btn'));
    expect(state.restore.mutate).toHaveBeenCalledOnce();
    const [, options] = state.restore.mutate.mock.calls[0] as [unknown, { onSuccess: () => void }];
    options.onSuccess();
    expect(state.navigate).toHaveBeenCalledWith({ to: '/', replace: true });
  });

  it('signs out', () => {
    wrap(<AccountDeletionPage />);
    fireEvent.click(screen.getByTestId('account-deletion-signout-btn'));
    expect(state.logout.mutate).toHaveBeenCalledOnce();
  });

  it('leaves for home when the account is not pending deletion', () => {
    state.currentUser = { deletionRequestedAt: null };
    wrap(<AccountDeletionPage />);
    expect(screen.queryByTestId('account-deletion-page')).toBeNull();
    expect(state.navigate).toHaveBeenCalledWith({ to: '/', replace: true });
  });

  it('leaves for the login page when signed out', () => {
    state.accessToken = null;
    wrap(<AccountDeletionPage />);
    expect(state.navigate).toHaveBeenCalledWith({ to: '/login', replace: true });
  });
});
