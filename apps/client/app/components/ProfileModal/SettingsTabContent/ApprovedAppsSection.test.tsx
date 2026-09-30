// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockUseOAuthGrants = vi.fn();
const mockMutate = vi.fn();
const mockUseRevokeOAuthGrant = vi.fn(() => ({ mutate: mockMutate }));
const mockUseAccessToken = vi.fn(() => false);

vi.mock('@client/app/hooks/data/oauthGrants', () => ({
  useOAuthGrants: () => mockUseOAuthGrants(),
  useRevokeOAuthGrant: () => mockUseRevokeOAuthGrant(),
}));

vi.mock('@client/app/hooks/useAccessToken', () => ({
  // The hook is called as useAccessToken(selector) -- pass the selector over the state object.
  useAccessToken: (selector: (s: { impersonating: boolean }) => boolean) =>
    selector({ impersonating: mockUseAccessToken() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@client/app/routes/oauth/consentScopes', () => ({
  toConsentScopes: (scopes: string[]) => scopes.map(id => ({ id, label: id })),
}));

import ApprovedAppsSection from './ApprovedAppsSection';

const GRANT_A = {
  clientId: 'client-a',
  clientName: 'TestApp',
  scopes: ['openid', 'profile'],
  approvedAt: '2026-06-15T00:00:00.000Z',
};

const GRANT_B = {
  clientId: 'client-b',
  clientName: 'AnotherApp',
  scopes: ['email'],
  approvedAt: '2026-07-01T00:00:00.000Z',
};

describe('ApprovedAppsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRevokeOAuthGrant.mockReturnValue({ mutate: mockMutate });
    mockUseAccessToken.mockReturnValue(false);
  });

  it('shows empty state when there are no grants', () => {
    mockUseOAuthGrants.mockReturnValue({ data: [], isLoading: false, isError: false });
    render(<ApprovedAppsSection />);
    expect(screen.getByTestId('approved-apps-empty')).toBeTruthy();
  });

  it('shows loading text while fetching', () => {
    mockUseOAuthGrants.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<ApprovedAppsSection />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('shows an error state when the fetch fails', () => {
    mockUseOAuthGrants.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<ApprovedAppsSection />);
    expect(screen.getByTestId('approved-apps-error')).toBeTruthy();
    expect(screen.queryByTestId('approved-apps-empty')).toBeNull();
  });

  it('renders a row for each grant with name, scope chips, and revoke button', () => {
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A, GRANT_B], isLoading: false, isError: false });
    render(<ApprovedAppsSection />);
    expect(screen.getByText('TestApp')).toBeTruthy();
    expect(screen.getByText('AnotherApp')).toBeTruthy();
    // scope chips
    expect(screen.getByTitle('openid')).toBeTruthy();
    expect(screen.getByTitle('email')).toBeTruthy();
    expect(screen.getByTestId('approved-app-revoke-btn-client-a')).toBeTruthy();
    expect(screen.getByTestId('approved-app-revoke-btn-client-b')).toBeTruthy();
  });

  it('calls revoke mutation with the correct clientId and all lifecycle callbacks', () => {
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A], isLoading: false, isError: false });
    render(<ApprovedAppsSection />);
    fireEvent.click(screen.getByTestId('approved-app-revoke-btn-client-a'));
    expect(mockMutate).toHaveBeenCalledWith(
      { clientId: 'client-a' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
        onSettled: expect.any(Function),
      })
    );
  });

  it('shows a success toast after revoke succeeds', async () => {
    const { toast } = await import('sonner');
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A], isLoading: false, isError: false });
    mockMutate.mockImplementation((_vars: unknown, callbacks: any) => {
      callbacks.onSuccess();
      callbacks.onSettled();
    });
    render(<ApprovedAppsSection />);
    fireEvent.click(screen.getByTestId('approved-app-revoke-btn-client-a'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Access revoked for TestApp'));
  });

  it('shows an error toast when revoke fails', async () => {
    const { toast } = await import('sonner');
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A], isLoading: false, isError: false });
    mockMutate.mockImplementation((_vars: unknown, callbacks: any) => {
      callbacks.onError();
      callbacks.onSettled();
    });
    render(<ApprovedAppsSection />);
    fireEvent.click(screen.getByTestId('approved-app-revoke-btn-client-a'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not revoke access for TestApp'));
  });

  it('only marks the clicked row as loading (aria-busy), not all rows', () => {
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A, GRANT_B], isLoading: false, isError: false });
    // mutate that never calls onSettled so the pending state stays
    mockMutate.mockImplementation(() => {});
    render(<ApprovedAppsSection />);
    fireEvent.click(screen.getByTestId('approved-app-revoke-btn-client-a'));
    const btnA = screen.getByTestId('approved-app-revoke-btn-client-a');
    const btnB = screen.getByTestId('approved-app-revoke-btn-client-b');
    expect(btnA.getAttribute('aria-busy')).toBe('true');
    expect(btnB.getAttribute('aria-busy')).toBeNull();
  });

  it('spinner clears after onSettled fires', async () => {
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A], isLoading: false, isError: false });
    let settle: () => void;
    mockMutate.mockImplementation((_vars: unknown, callbacks: any) => {
      callbacks.onSuccess();
      settle = callbacks.onSettled;
    });
    render(<ApprovedAppsSection />);
    fireEvent.click(screen.getByTestId('approved-app-revoke-btn-client-a'));
    const btn = screen.getByTestId('approved-app-revoke-btn-client-a');
    expect(btn.getAttribute('aria-busy')).toBe('true');
    await waitFor(() => {
      settle();
    });
    await waitFor(() => expect(btn.getAttribute('aria-busy')).toBeNull());
  });

  it('hides the Revoke button while impersonating', () => {
    mockUseAccessToken.mockReturnValue(true);
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A], isLoading: false, isError: false });
    render(<ApprovedAppsSection />);
    expect(screen.queryByTestId('approved-app-revoke-btn-client-a')).toBeNull();
  });
});
