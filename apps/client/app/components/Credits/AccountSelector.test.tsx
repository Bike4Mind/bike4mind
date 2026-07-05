import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AccountSelector, { useSelectedAccount } from './AccountSelector';

const mockUseUser = vi.fn();
const mockSetLLM = vi.fn();
// Hoisted so the vi.mock factory (hoisted above imports) can reference it, yet stay
// reconfigurable per test - the reload-persistence test needs to flip its return value.
const { mockUseGetUserOrgs } = vi.hoisted(() => ({ mockUseGetUserOrgs: vi.fn() }));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => mockUseUser(),
}));

vi.mock('@client/app/contexts/LLMContext', () => ({
  // useLLM is called as useLLM(s => s.setLLM)
  useLLM: (selector: (s: { setLLM: typeof mockSetLLM }) => unknown) => selector({ setLLM: mockSetLLM }),
}));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetUserOrganizations: () => mockUseGetUserOrgs(),
}));

describe('AccountSelector — collapsed value sync on profile rename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the persisted selected-account store between tests
    useSelectedAccount.setState({ selectedAccount: null });
    // Default: org list resolved with no orgs (matches a solo user).
    mockUseGetUserOrgs.mockReturnValue({ data: [], isSuccess: true, refetch: vi.fn() });
  });

  it('updates the collapsed dropdown name when the user renames their profile (no reload)', async () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', name: 'Old Name', currentCredits: 10000 } });

    const { rerender } = render(<AccountSelector />);

    // Personal account is auto-selected; collapsed value shows the user's name.
    await waitFor(() => expect(screen.getAllByText('Old Name').length).toBeGreaterThan(0));

    // Simulate a profile rename: currentUser.name changes, credits unchanged.
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', name: 'New Name', currentCredits: 10000 } });
    rerender(<AccountSelector />);

    // Collapsed dropdown must reflect the new name without a hard refresh.
    await waitFor(() => expect(screen.getAllByText('New Name').length).toBeGreaterThan(0));
    expect(screen.queryByText('Old Name')).not.toBeInTheDocument();
  });
});

describe('AccountSelector — active Team context survives reload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSelectedAccount.setState({ selectedAccount: null });
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', name: 'Owner', currentCredits: 10000 } });
  });

  it('does not reset a persisted Team selection to Personal while orgs are still loading', async () => {
    // Persisted Team account from a prior session (what Zustand persist restores on reload).
    useSelectedAccount.setState({
      selectedAccount: { id: 'org-1', name: 'Acme', personal: false, credits: 500 },
    });
    // Orgs not resolved yet - org accounts load after first paint, so the account list is
    // briefly just [Personal] and the persisted Team account looks "missing".
    mockUseGetUserOrgs.mockReturnValue({ data: undefined, isSuccess: false, refetch: vi.fn() });

    render(<AccountSelector />);

    // The guard must NOT wipe the Team selection during the loading window.
    await waitFor(() => expect(useSelectedAccount.getState().selectedAccount?.id).toBe('org-1'));
  });

  it('does reset to Personal once orgs resolve and the selected account is genuinely gone', async () => {
    useSelectedAccount.setState({
      selectedAccount: { id: 'org-gone', name: 'Left Org', personal: false, credits: 0 },
    });
    // Orgs resolved, and the persisted org is no longer among them (user left it).
    mockUseGetUserOrgs.mockReturnValue({ data: [], isSuccess: true, refetch: vi.fn() });

    render(<AccountSelector />);

    await waitFor(() => {
      const selected = useSelectedAccount.getState().selectedAccount;
      expect(selected?.personal).toBe(true);
      expect(selected?.id).toBe('user-1');
    });
  });
});
