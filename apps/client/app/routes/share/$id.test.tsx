// @vitest-environment jsdom
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { fetchInvite } from '@client/app/utils/invitesAPICalls';
import SharePage from './$id';

const mockId = vi.hoisted(() => ({ value: 'abc' }));

vi.mock('@client/app/utils/invitesAPICalls', () => ({
  fetchInvite: vi.fn(),
}));
const inviteMutations = vi.hoisted(() => ({
  accept: vi.fn(),
  refuse: vi.fn(),
  respond: vi.fn(),
}));
vi.mock('@client/app/hooks/data/invites', () => ({
  useAcceptDocument: () => ({ mutateAsync: inviteMutations.accept }),
  useRefuseDocument: () => ({ mutateAsync: inviteMutations.refuse }),
  useRespondToInvites: () => ({ mutateAsync: inviteMutations.respond }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { username: 'me' } }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: mockId.value }),
}));

const loadedInvite = { name: 'Doc', type: 'FabFile', username: 'someone-else' } as never;

const appTheme = extendTheme({ ...getThemeConfig() });

const renderPage = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <SharePage />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

describe('SharePage', () => {
  beforeEach(() => {
    vi.mocked(fetchInvite).mockReset();
    mockId.value = 'abc';
    Object.values(inviteMutations).forEach(m => m.mockReset().mockResolvedValue(undefined));
  });

  it('accepts a multi-invite link with one bulk request and no per-invite calls', async () => {
    mockId.value = 'a,b,c,d,e';
    vi.mocked(fetchInvite).mockResolvedValue(loadedInvite);
    renderPage();

    fireEvent.click(await screen.findByLabelText('Accept'));

    await vi.waitFor(() => expect(inviteMutations.respond).toHaveBeenCalledTimes(1));
    expect(inviteMutations.respond).toHaveBeenCalledWith({ action: 'accept', ids: ['a', 'b', 'c', 'd', 'e'] });
    expect(inviteMutations.accept).not.toHaveBeenCalled();
  });

  it('refuses a multi-invite link with one bulk request', async () => {
    mockId.value = 'a,b,c';
    vi.mocked(fetchInvite).mockResolvedValue(loadedInvite);
    renderPage();

    fireEvent.click(await screen.findByLabelText('Refuse'));

    await vi.waitFor(() => expect(inviteMutations.respond).toHaveBeenCalledTimes(1));
    expect(inviteMutations.respond).toHaveBeenCalledWith({ action: 'refuse', ids: ['a', 'b', 'c'] });
    expect(inviteMutations.refuse).not.toHaveBeenCalled();
  });

  it('keeps a single invite on the single-invite accept call', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(loadedInvite);
    renderPage();

    fireEvent.click(await screen.findByLabelText('Accept'));

    await vi.waitFor(() => expect(inviteMutations.accept).toHaveBeenCalledWith('abc'));
    expect(inviteMutations.respond).not.toHaveBeenCalled();
  });

  it('still renders Accept when one of several invites has expired', async () => {
    mockId.value = 'a,b';
    vi.mocked(fetchInvite).mockImplementation(async id => (id === 'a' ? 'expired' : loadedInvite));
    renderPage();

    expect(await screen.findByLabelText('Accept')).toBeTruthy();
    expect(screen.queryByTestId('share-expired-modal')).toBeNull();
    expect(screen.queryByTestId('share-unavailable-modal')).toBeNull();
  });

  it('still renders Accept when one of several invites fails with a non-404 error', async () => {
    mockId.value = 'a,b';
    vi.mocked(fetchInvite).mockImplementation(async id => {
      if (id === 'a') throw new Error('boom');
      return loadedInvite;
    });
    renderPage();

    expect(await screen.findByLabelText('Accept')).toBeTruthy();
    expect(screen.queryByTestId('share-error-modal')).toBeNull();
  });

  it('shows an unavailable modal, never Accept, when the invite is gone (404)', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(null);
    renderPage();

    expect(await screen.findByTestId('share-unavailable-modal')).toBeTruthy();
    expect(screen.getByTestId('share-unavailable-home-btn')).toBeTruthy();
    expect(screen.queryByLabelText('Accept')).toBeNull();
  });

  it('shows an expired modal, never Accept, when the invite has expired (410)', async () => {
    vi.mocked(fetchInvite).mockResolvedValue('expired');
    renderPage();

    expect(await screen.findByTestId('share-expired-modal')).toBeTruthy();
    expect(screen.getByTestId('share-expired-home-btn')).toBeTruthy();
    expect(screen.queryByTestId('share-unavailable-modal')).toBeNull();
    expect(screen.queryByLabelText('Accept')).toBeNull();
  });

  it('renders Accept for a loaded invite', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(loadedInvite);
    renderPage();

    expect(await screen.findByText('Doc')).toBeTruthy();
    expect(screen.getByLabelText('Accept')).toBeTruthy();
    expect(screen.queryByTestId('share-error-modal')).toBeNull();
  });

  it('shows the expired modal, never Accept, for a loaded invite whose expiresAt has passed', async () => {
    vi.mocked(fetchInvite).mockResolvedValue({
      ...loadedInvite,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    } as never);
    renderPage();

    expect(await screen.findByTestId('share-expired-modal')).toBeTruthy();
    expect(screen.queryByLabelText('Accept')).toBeNull();
  });

  it('shows the expired modal, not a retry modal, when one invite expired and another failed', async () => {
    mockId.value = 'a,b';
    vi.mocked(fetchInvite).mockImplementation(async id => {
      if (id === 'a') return 'expired';
      throw new Error('boom');
    });
    renderPage();

    expect(await screen.findByTestId('share-expired-modal')).toBeTruthy();
    expect(screen.queryByTestId('share-error-modal')).toBeNull();
  });

  it('shows a retryable error modal on a non-404 failure', async () => {
    vi.mocked(fetchInvite).mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByTestId('share-error-modal')).toBeTruthy();
    expect(screen.queryByLabelText('Accept')).toBeNull();
    expect(fetchInvite).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('share-error-retry-btn'));
    await vi.waitFor(() => expect(fetchInvite).toHaveBeenCalledTimes(2));
  });
});
