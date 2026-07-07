import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChangeEmailCard from './ChangeEmailCard';

// SectionContainer pulls in the help/import chain - stub it to just render children.
vi.mock('@client/app/components/ProfileModal/SectionContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Router: useSearch drives the email deep-link; useNavigate strips the param.
let mockSearch: Record<string, unknown> = {};
const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mockSearch,
  useNavigate: () => mockNavigate,
}));

// UserContext: useUser is called both bare (`useUser()`) and with a selector.
const mockRefreshUser = vi.fn().mockResolvedValue(undefined);
let mockCurrentUser: Record<string, unknown> | null = null;
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { currentUser: mockCurrentUser, refreshUser: mockRefreshUser };
    return selector ? selector(state) : state;
  },
}));

const mockPost = vi.fn().mockResolvedValue({ data: { message: 'ok' } });
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...args: unknown[]) => mockPost(...args) },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _k }),
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => mockToastSuccess(...a), error: (...a: unknown[]) => mockToastError(...a) },
}));

const renderCard = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider>
        <ChangeEmailCard />
      </CssVarsProvider>
    </QueryClientProvider>
  );

describe('ChangeEmailCard', () => {
  beforeEach(() => {
    mockPost.mockClear();
    mockNavigate.mockClear();
    mockRefreshUser.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockSearch = {};
    mockCurrentUser = { email: 'current@example.com', emailVerified: true, pendingEmail: 'new@example.com' };
  });

  it('renders the pending banner and Cancel button when a change is pending', () => {
    renderCard();
    expect(screen.getByTestId('profile-pending-email-alert')).toHaveTextContent('new@example.com');
    expect(screen.getByTestId('profile-cancel-email-change-btn')).toBeInTheDocument();
  });

  it('shows the Change button (no banner) when nothing is pending', () => {
    mockCurrentUser = { email: 'current@example.com', emailVerified: true, pendingEmail: null };
    renderCard();
    expect(screen.queryByTestId('profile-pending-email-alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-change-email-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-cancel-email-change-btn')).not.toBeInTheDocument();
  });

  it('fires the cancel-change request after confirming, and refreshes the user', async () => {
    renderCard();
    fireEvent.click(screen.getByTestId('profile-cancel-email-change-btn'));
    fireEvent.click(screen.getByTestId('profile-cancel-email-confirm-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/email/cancel-change'));
    await waitFor(() => expect(mockRefreshUser).toHaveBeenCalled());
  });

  it('does not fire a request when the confirm dialog is dismissed', () => {
    renderCard();
    fireEvent.click(screen.getByTestId('profile-cancel-email-change-btn'));
    fireEvent.click(screen.getByTestId('profile-cancel-email-dismiss-btn'));
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('opens the confirm dialog from the email deep link and strips the action param', async () => {
    mockSearch = { action: 'cancel-email-change', tab: 'profile' };
    renderCard();

    // Confirmation dialog auto-opens (but does NOT auto-cancel - explicit click still required).
    expect(await screen.findByTestId('profile-cancel-email-confirm-btn')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();

    // The action param is stripped so a reload/back-nav won't reopen the dialog; tab is preserved.
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    const navArg = mockNavigate.mock.calls[0][0];
    expect(navArg.search).not.toHaveProperty('action');
    expect(navArg.search).toEqual({ tab: 'profile' });
    expect(navArg.replace).toBe(true);
  });

  it('does not open the dialog from the deep link when there is no pending change', () => {
    mockCurrentUser = { email: 'current@example.com', emailVerified: true, pendingEmail: null };
    mockSearch = { action: 'cancel-email-change' };
    renderCard();
    expect(screen.queryByTestId('profile-cancel-email-confirm-btn')).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
