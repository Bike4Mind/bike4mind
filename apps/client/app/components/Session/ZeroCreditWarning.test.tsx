import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const { state, navigate, post, gearsSignal } = vi.hoisted(() => ({
  state: {
    currentUser: { emailVerified: true, tags: [] as string[] } as { emailVerified: boolean; tags: string[] },
    selectedAccount: null as { personal: boolean } | null,
    claimableCount: 0,
  },
  navigate: vi.fn(),
  post: vi.fn(),
  gearsSignal: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: unknown }) => unknown) => selector({ currentUser: state.currentUser }),
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: unknown }) => unknown) =>
    selector({ selectedAccount: state.selectedAccount }),
}));
vi.mock('@client/app/hooks/useVisibleGears', () => ({
  useGearsNavSignal: () => {
    gearsSignal();
    return { startHere: false, startHereCredits: 0, claimableCount: state.claimableCount };
  },
}));
vi.mock('./CreditOfferActions', () => ({
  CreditOfferActions: () => <div data-testid="credit-offer-actions" />,
}));

import { ZeroCreditWarning } from './ZeroCreditWarning';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWarning = (hasDraft = false) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <ZeroCreditWarning hasDraft={hasDraft} />
      </CssVarsProvider>
    </QueryClientProvider>
  );

describe('ZeroCreditWarning', () => {
  beforeEach(() => {
    state.currentUser = { emailVerified: true, tags: [] };
    state.selectedAccount = null;
    state.claimableCount = 0;
    navigate.mockClear();
    gearsSignal.mockClear();
    post.mockReset();
    post.mockResolvedValue({ data: {} });
  });

  it('says the credits are used up and offers no free route when there is none', () => {
    renderWarning();
    expect(screen.getByTestId('credits-warning-reason')).toHaveTextContent("You've used all of your credits.");
    expect(screen.queryByTestId('credits-warning-free-routes')).toBeNull();
    expect(screen.getByTestId('credit-offer-actions')).toBeInTheDocument();
  });

  it('offers a claimable Gears reward and opens Gears', () => {
    state.claimableCount = 2;
    renderWarning();
    fireEvent.click(screen.getByTestId('credits-warning-gears-btn'));
    expect(navigate).toHaveBeenCalledWith({ to: '/gears' });
  });

  it('explains a pending grant and resends the verification email', async () => {
    state.currentUser = { emailVerified: false, tags: [PENDING_FREE_CREDITS_TAG] };
    renderWarning();
    expect(screen.getByTestId('credits-warning-reason')).toHaveTextContent(/held until you verify your email/i);
    fireEvent.click(screen.getByTestId('credits-warning-verify-btn'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/email/resend-verification'));
    await waitFor(() => expect(screen.getByTestId('credits-warning-verify-btn')).toHaveTextContent(/email sent/i));
  });

  it('lets the user retry when the resend fails', async () => {
    state.currentUser = { emailVerified: false, tags: [PENDING_FREE_CREDITS_TAG] };
    post.mockRejectedValueOnce(new Error('503'));
    renderWarning();
    fireEvent.click(screen.getByTestId('credits-warning-verify-btn'));
    await waitFor(() => expect(screen.getByTestId('credits-warning-verify-btn')).toHaveTextContent(/try again/i));
    expect(screen.getByTestId('credits-warning-verify-btn')).not.toBeDisabled();
  });

  it('shows the rate-limit message when the resend is refused with a 429', async () => {
    state.currentUser = { emailVerified: false, tags: [PENDING_FREE_CREDITS_TAG] };
    post.mockRejectedValueOnce({ response: { status: 429 } });
    renderWarning();
    fireEvent.click(screen.getByTestId('credits-warning-verify-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('credits-warning-verify-error')).toHaveTextContent(/wait 15 minutes/i)
    );
  });

  it('shows a retryable error when the server rejects resend with an empty message', async () => {
    state.currentUser = { emailVerified: false, tags: [PENDING_FREE_CREDITS_TAG] };
    post.mockRejectedValueOnce({ response: { status: 500, data: { message: '' } } });
    renderWarning();
    fireEvent.click(screen.getByTestId('credits-warning-verify-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('credits-warning-verify-error')).toHaveTextContent(
        'Failed to send verification email. Please try again later.'
      )
    );
    expect(screen.getByTestId('credits-warning-verify-btn')).toHaveTextContent(/try again/i);
    expect(screen.getByTestId('credits-warning-verify-btn')).not.toBeDisabled();
  });

  it('shows the server message when the email service is not configured', async () => {
    state.currentUser = { emailVerified: false, tags: [PENDING_FREE_CREDITS_TAG] };
    post.mockRejectedValueOnce({
      response: { status: 503, data: { isConfigError: true, message: 'Email service is not configured.' } },
    });
    renderWarning();
    fireEvent.click(screen.getByTestId('credits-warning-verify-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('credits-warning-verify-error')).toHaveTextContent('Email service is not configured.')
    );
  });

  it('does not query Gears for an organization account', () => {
    state.selectedAccount = { personal: false };
    renderWarning();
    expect(gearsSignal).not.toHaveBeenCalled();
  });

  it('offers no free route on an organization account', () => {
    state.selectedAccount = { personal: false };
    state.claimableCount = 1;
    state.currentUser = { emailVerified: false, tags: [PENDING_FREE_CREDITS_TAG] };
    renderWarning();
    expect(screen.queryByTestId('credits-warning-free-routes')).toBeNull();
    expect(screen.getByTestId('credits-warning-reason')).toHaveTextContent(
      'Your organization has used all of its credits.'
    );
  });

  it('shows the saved-message line only with a draft', () => {
    const { unmount } = renderWarning(false);
    expect(screen.queryByTestId('credits-warning-draft-saved')).toBeNull();
    unmount();
    renderWarning(true);
    expect(screen.getByTestId('credits-warning-draft-saved')).toBeInTheDocument();
  });
});
