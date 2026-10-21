import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';

const { submitReferral, refreshUser } = vi.hoisted(() => ({ submitReferral: vi.fn(), refreshUser: vi.fn() }));
vi.mock('@client/app/contexts/UserContext', async () => {
  const { create } = await import('zustand');
  return {
    useUser: create(() => ({
      currentUser: { id: 'sender', name: 'Sender', numReferralsAvailable: 2 },
      refreshUser: () => refreshUser(),
    })),
  };
});
vi.mock('@client/app/contexts/UserSettingsContext', () => ({ useServerSettings: () => ({ serverSettings: [] }) }));
vi.mock('@client/app/utils/regInviteAPICalls', () => ({
  submitReferral,
  createRegInvites: vi.fn(),
  deleteRegInvites: vi.fn(),
  getRegInvitesFromServer: vi.fn(),
  submitUserInvitation: vi.fn(),
  updateRegInvites: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useUser } from '@client/app/contexts/UserContext';
import { ReferralModal, useReferralModal } from './ReferralModal';
const theme = extendTheme({ ...getThemeConfig() });

it('preserves refreshed quota when another request spends the remaining slot before success', async () => {
  const refresh = Promise.withResolvers<void>();
  submitReferral.mockResolvedValue({ message: 'processed', sent: ['friend@example.com'], failed: [] });
  refreshUser.mockImplementation(async () => {
    useUser.setState(state => ({
      currentUser: state.currentUser ? { ...state.currentUser, numReferralsAvailable: 0 } : null,
    }));
    await refresh.promise;
  });
  useReferralModal.setState({ isOpen: true });
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <ReferralModal />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  await waitFor(() => expect(screen.getByTestId('referral-quota-count')).toHaveTextContent('2'));
  fireEvent.change(screen.getByTestId('referral-email-input'), { target: { value: 'friend@example.com' } });
  fireEvent.click(screen.getByTestId('referral-submit-button'));
  await waitFor(() => expect(screen.getByTestId('referral-quota-count')).toHaveTextContent('0'));
  await act(async () => {
    refresh.resolve();
  });
  await waitFor(() => expect(useReferralModal.getState().isOpen).toBe(false));
  act(() => useReferralModal.getState().open());
  expect(screen.getByTestId('referral-quota-count')).toHaveTextContent('0');
  expect(screen.getByTestId('referral-submit-button')).toBeDisabled();
  queryClient.clear();
});
