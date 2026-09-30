// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockUseOAuthGrants = vi.fn();
const mockMutate = vi.fn();
const mockUseRevokeOAuthGrant = vi.fn(() => ({
  mutate: mockMutate,
  isPending: false,
}));

vi.mock('@client/app/hooks/data/oauthGrants', () => ({
  useOAuthGrants: () => mockUseOAuthGrants(),
  useRevokeOAuthGrant: () => mockUseRevokeOAuthGrant(),
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
    mockUseRevokeOAuthGrant.mockReturnValue({ mutate: mockMutate, isPending: false });
  });

  it('shows empty state when there are no grants', () => {
    mockUseOAuthGrants.mockReturnValue({ data: [], isLoading: false });
    render(<ApprovedAppsSection />);
    expect(screen.getByTestId('approved-apps-empty')).toBeTruthy();
  });

  it('shows loading text while fetching', () => {
    mockUseOAuthGrants.mockReturnValue({ data: undefined, isLoading: true });
    render(<ApprovedAppsSection />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('renders a row for each grant with name, scope chips, and revoke button', () => {
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A, GRANT_B], isLoading: false });
    render(<ApprovedAppsSection />);
    expect(screen.getByText('TestApp')).toBeTruthy();
    expect(screen.getByText('AnotherApp')).toBeTruthy();
    expect(screen.getByTestId('approved-app-revoke-btn-client-a')).toBeTruthy();
    expect(screen.getByTestId('approved-app-revoke-btn-client-b')).toBeTruthy();
  });

  it('calls revoke mutation with the correct clientId when Revoke is clicked', () => {
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A], isLoading: false });
    render(<ApprovedAppsSection />);
    fireEvent.click(screen.getByTestId('approved-app-revoke-btn-client-a'));
    expect(mockMutate).toHaveBeenCalledWith(
      { clientId: 'client-a' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) })
    );
  });

  it('shows a success toast after revoke succeeds', async () => {
    const { toast } = await import('sonner');
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A], isLoading: false });
    mockMutate.mockImplementation((_vars: unknown, callbacks: any) => callbacks.onSuccess());
    render(<ApprovedAppsSection />);
    fireEvent.click(screen.getByTestId('approved-app-revoke-btn-client-a'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Access revoked for TestApp'));
  });

  it('shows an error toast when revoke fails', async () => {
    const { toast } = await import('sonner');
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A], isLoading: false });
    mockMutate.mockImplementation((_vars: unknown, callbacks: any) => callbacks.onError());
    render(<ApprovedAppsSection />);
    fireEvent.click(screen.getByTestId('approved-app-revoke-btn-client-a'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not revoke access for TestApp'));
  });

  it('only marks the clicked row as loading, not all rows', async () => {
    mockUseOAuthGrants.mockReturnValue({ data: [GRANT_A, GRANT_B], isLoading: false });
    // mutate that never calls onSettled so the pending state stays
    mockMutate.mockImplementation(() => {});
    render(<ApprovedAppsSection />);
    fireEvent.click(screen.getByTestId('approved-app-revoke-btn-client-a'));
    const btnA = screen.getByTestId('approved-app-revoke-btn-client-a');
    const btnB = screen.getByTestId('approved-app-revoke-btn-client-b');
    // MUI Joy sets aria-busy on loading buttons
    expect(btnA.getAttribute('aria-busy')).toBe('true');
    expect(btnB.getAttribute('aria-busy')).not.toBe('true');
  });
});
