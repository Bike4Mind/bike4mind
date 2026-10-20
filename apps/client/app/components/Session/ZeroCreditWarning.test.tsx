import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const { state, navigate, post } = vi.hoisted(() => ({
  state: {
    currentUser: { emailVerified: true, tags: [] as string[] } as { emailVerified: boolean; tags: string[] },
    selectedAccount: null as { personal: boolean } | null,
    claimableCount: 0,
  },
  navigate: vi.fn(),
  post: vi.fn(),
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
  useGearsNavSignal: () => ({ startHere: false, startHereCredits: 0, claimableCount: state.claimableCount }),
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
