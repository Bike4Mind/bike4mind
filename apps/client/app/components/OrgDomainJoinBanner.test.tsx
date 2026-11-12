import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import OrgDomainJoinBanner from './OrgDomainJoinBanner';

type MockUser = { id: string; emailVerified?: boolean } | null;
let mockCurrentUser: MockUser = null;
const mockRefreshUser = vi.fn().mockResolvedValue(undefined);

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: MockUser; refreshUser: () => Promise<void> }) => unknown) =>
    selector({ currentUser: mockCurrentUser, refreshUser: mockRefreshUser }),
}));

const api = vi.hoisted(() => ({ fetchSuggestions: vi.fn(), join: vi.fn() }));
vi.mock('@client/app/utils/orgDomainAPICalls', () => ({
  fetchOrgDomainJoinSuggestions: api.fetchSuggestions,
  joinOrgViaDomain: api.join,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const SUGGESTION = { organizationId: 'org1', organizationName: 'Acme', claimId: 'c1' };

const renderBanner = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <OrgDomainJoinBanner />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockCurrentUser = { id: 'u1', emailVerified: true };
  api.fetchSuggestions.mockResolvedValue([SUGGESTION]);
  api.join.mockResolvedValue({ joined: true });
});

describe('OrgDomainJoinBanner', () => {
  it('offers the suggested org', async () => {
    renderBanner();
    expect(await screen.findByTestId('org-domain-join-banner')).toHaveTextContent('Acme');
  });

  it('joins through the API, then refreshes the user and the suggestions', async () => {
    renderBanner();
    api.fetchSuggestions.mockResolvedValue([]);
    fireEvent.click(await screen.findByTestId('org-domain-join-btn'));

    await waitFor(() => expect(api.join).toHaveBeenCalledWith('org1', expect.anything()));
    await waitFor(() => expect(mockRefreshUser).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('org-domain-join-banner')).not.toBeInTheDocument());
  });

  it('shows the server message when the join is refused', async () => {
    api.join.mockRejectedValue({ response: { data: { message: 'Organization is at full capacity' } } });
    renderBanner();
    fireEvent.click(await screen.findByTestId('org-domain-join-btn'));
    expect(await screen.findByTestId('org-domain-join-error')).toHaveTextContent('Organization is at full capacity');
  });

  it('hides on dismiss and stays hidden for that org on the next mount', async () => {
    const { unmount } = renderBanner();
    fireEvent.click(await screen.findByTestId('org-domain-join-dismiss-btn'));
    expect(screen.queryByTestId('org-domain-join-banner')).not.toBeInTheDocument();
    unmount();

    renderBanner();
    await waitFor(() => expect(api.fetchSuggestions).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('org-domain-join-banner')).not.toBeInTheDocument();
  });

  it('renders nothing when there are no suggestions', async () => {
    api.fetchSuggestions.mockResolvedValue([]);
    renderBanner();
    await waitFor(() => expect(api.fetchSuggestions).toHaveBeenCalled());
    expect(screen.queryByTestId('org-domain-join-banner')).not.toBeInTheDocument();
  });

  it.each([
    ['signed out', null],
    ['with an unverified email', { id: 'u1', emailVerified: false }],
  ])('does not ask the server when %s', async (_label, user) => {
    mockCurrentUser = user;
    renderBanner();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(api.fetchSuggestions).not.toHaveBeenCalled();
    expect(screen.queryByTestId('org-domain-join-banner')).not.toBeInTheDocument();
  });
});
