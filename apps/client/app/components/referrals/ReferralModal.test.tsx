import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';

const { submitReferral, submitUserInvitation, refreshUser } = vi.hoisted(() => ({
  submitReferral: vi.fn(),
  submitUserInvitation: vi.fn(),
  refreshUser: vi.fn(),
}));
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
  submitUserInvitation,
  updateRegInvites: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useUser } from '@client/app/contexts/UserContext';
import { toast } from 'sonner';
import { ReferralInviteType, ReferralModal, useReferralModal } from './ReferralModal';
const theme = extendTheme({ ...getThemeConfig() });

const renderModal = (inviteType?: ReferralInviteType) => {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <ReferralModal inviteType={inviteType} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return queryClient;
};

beforeEach(() => {
  vi.clearAllMocks();
  useReferralModal.setState({ isOpen: false });
  useUser.setState({ currentUser: { id: 'sender', name: 'Sender', numReferralsAvailable: 2 } });
});

it('clears the spinner and stays open when the referral is rejected', async () => {
  submitReferral.mockRejectedValue(new Error('Not enough referrals available'));
  useReferralModal.setState({ isOpen: true });
  const queryClient = renderModal();
  await waitFor(() => expect(screen.getByTestId('referral-quota-count')).toHaveTextContent('2'));
  fireEvent.change(screen.getByTestId('referral-email-input'), { target: { value: 'friend@example.com' } });
  fireEvent.click(screen.getByTestId('referral-submit-button'));
  await waitFor(() => expect(screen.queryByTestId('referral-submit-spinner')).toBeNull());
  // The sender has to see why nothing was sent, and their input must survive to be retried.
  expect(toast.error).toHaveBeenCalledWith('Not enough referrals available');
  expect(screen.getByTestId('referral-email-input')).toHaveValue('friend@example.com');
  expect(useReferralModal.getState().isOpen).toBe(true);
  queryClient.clear();
});

it('adopts the refreshed quota after a send instead of decrementing it locally', async () => {
  const refresh = Promise.withResolvers<void>();
  submitReferral.mockResolvedValue({ message: 'processed', sent: ['friend@example.com'], failed: [] });
  refreshUser.mockImplementation(async () => {
    await refresh.promise;
    useUser.setState(state => ({
      currentUser: state.currentUser ? { ...state.currentUser, numReferralsAvailable: 0 } : null,
    }));
  });
  useReferralModal.setState({ isOpen: true });
  const queryClient = renderModal();
  await waitFor(() => expect(screen.getByTestId('referral-quota-count')).toHaveTextContent('2'));
  fireEvent.change(screen.getByTestId('referral-email-input'), { target: { value: 'friend@example.com' } });
  fireEvent.click(screen.getByTestId('referral-submit-button'));
  // Closing does not wait on /api/identify; the server owns the count, so the refreshed
  // value lands whenever it lands and the modal picks it up from the user store.
  await waitFor(() => expect(useReferralModal.getState().isOpen).toBe(false));
  await act(async () => {
    refresh.resolve();
  });
  act(() => useReferralModal.getState().open());
  await waitFor(() => expect(screen.getByTestId('referral-quota-count')).toHaveTextContent('0'));
  expect(screen.getByTestId('referral-submit-button')).toBeDisabled();
  queryClient.clear();
});

it('decrements the local quota in userInvitation mode without going below zero', async () => {
  submitUserInvitation.mockResolvedValue({ message: 'invited' });
  useUser.setState({ currentUser: { id: 'sender', name: 'Sender', numReferralsAvailable: 1 } });
  useReferralModal.setState({ isOpen: true });
  const queryClient = renderModal(ReferralInviteType.userInvitation);
  await waitFor(() => expect(screen.getByTestId('referral-quota-count')).toHaveTextContent('1'));
  fireEvent.change(screen.getByTestId('referral-email-input'), { target: { value: 'a@example.com, b@example.com' } });
  fireEvent.click(screen.getByTestId('referral-submit-button'));
  await waitFor(() => expect(useReferralModal.getState().isOpen).toBe(false));
  act(() => useReferralModal.getState().open());
  // Two invites against one slot clamps at zero rather than showing a negative count.
  await waitFor(() => expect(screen.getByTestId('referral-quota-count')).toHaveTextContent('0'));
  expect(screen.getByTestId('referral-submit-button')).toBeDisabled();
  queryClient.clear();
});
