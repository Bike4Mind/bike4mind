// @vitest-environment jsdom
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { fetchInvite } from '@client/app/utils/invitesAPICalls';
import { AxiosError } from 'axios';
import SharePage from './$id';

const mockId = vi.hoisted(() => ({ value: 'abc' }));
const navigateMock = vi.hoisted(() => vi.fn());

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
  useNavigate: () => navigateMock,
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
    navigateMock.mockReset();
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

  it('deduplicates ids and preserves the URL order', async () => {
    mockId.value = 'z,a,z';
    vi.mocked(fetchInvite).mockResolvedValue(loadedInvite);
    renderPage();
    fireEvent.click(await screen.findByLabelText('Accept'));
    await vi.waitFor(() => expect(inviteMutations.respond).toHaveBeenCalledWith({ action: 'accept', ids: ['z', 'a'] }));
    expect(vi.mocked(fetchInvite).mock.calls.map(([id]) => id)).toEqual(['z', 'a']);
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
  const orgLink = {
    name: 'Acme',
    type: 'Organization',
    isLinkOnly: true,
    documentId: 'org-1',
    username: 'owner',
  } as never;
  const acceptRejects = (message: string, status: number) =>
    inviteMutations.accept.mockRejectedValue(
      new AxiosError('fail', 'ERR', undefined, undefined, {
        status,
        data: { name: 'UnprocessableEntityError', error: message, request_id: 'req-1' },
      } as never)
    );

  it('shows a revoked modal, never Accept, when the link was revoked before opening', async () => {
    vi.mocked(fetchInvite).mockResolvedValue('revoked');
    renderPage();

    expect(await screen.findByTestId('share-revoked-modal')).toBeTruthy();
    expect(screen.queryByTestId('share-error-modal')).toBeNull();
    expect(screen.queryByLabelText('Accept')).toBeNull();
  });

  it('offers Accept but not Refuse on an organization share link', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(orgLink);
    renderPage();

    expect(await screen.findByLabelText('Accept')).toBeTruthy();
    expect(screen.queryByLabelText('Refuse')).toBeNull();
  });

  it.each([
    ['Invite has been revoked', 422, 'revoked'],
    ['This invite is limited to verified email addresses at example.com', 403, 'domain'],
    ['Organization is full', 403, 'full'],
    ['Invite has no remaining users', 422, 'used'],
  ])('explains a refused join (%s) instead of going home', async (message, status, kind) => {
    vi.mocked(fetchInvite).mockResolvedValue(orgLink);
    acceptRejects(message, status);
    renderPage();

    fireEvent.click(await screen.findByLabelText('Accept'));

    expect(await screen.findByTestId(`share-accept-${kind}-modal`)).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('sends an existing member to the organization', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(orgLink);
    acceptRejects('You are already a member of this organization', 409);
    renderPage();

    fireEvent.click(await screen.findByLabelText('Accept'));
    fireEvent.click(await screen.findByTestId('share-accept-member-btn'));

    expect(navigateMock).toHaveBeenCalledWith({ to: '/organizations/$id', params: { id: 'org-1' } });
  });

  it('sends the minter of an org link through accept to the already-member screen', async () => {
    vi.mocked(fetchInvite).mockResolvedValue({ ...(orgLink as object), username: 'me' } as never);
    acceptRejects('You are already a member of this organization', 409);
    renderPage();

    fireEvent.click(await screen.findByLabelText('Accept'));

    expect(await screen.findByTestId('share-accept-member-modal')).toBeTruthy();
    expect(inviteMutations.accept).toHaveBeenCalledTimes(1);
  });

  describe('named organization invite', () => {
    const namedOrgInvite = { name: 'Acme', type: 'Organization', documentId: 'org-1', username: 'owner' } as never;
    // Shape of the POST /api/invites/[id]/accept body: the invitee-filtered invite plus acceptOutcome.
    const acceptBody = (acceptOutcome: 'accepted' | 'already-member') => ({
      id: 'abc',
      type: 'Organization',
      documentId: 'org-1',
      recipients: { pending: [], accepted: ['me@x.com'], refused: [] },
      acceptOutcome,
    });

    it('tells an existing member their role is unchanged and offers the organization', async () => {
      vi.mocked(fetchInvite).mockResolvedValue(namedOrgInvite);
      inviteMutations.accept.mockResolvedValue(acceptBody('already-member'));
      renderPage();

      fireEvent.click(await screen.findByLabelText('Accept'));

      const modal = await screen.findByTestId('share-accept-already-member-modal');
      expect(modal.textContent).toContain('An organization owner can change your role');
      expect(navigateMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('share-accept-already-member-btn'));
      expect(navigateMock).toHaveBeenCalledWith({ to: '/organizations/$id', params: { id: 'org-1' } });
    });

    it('goes home after a new member joins', async () => {
      vi.mocked(fetchInvite).mockResolvedValue(namedOrgInvite);
      inviteMutations.accept.mockResolvedValue(acceptBody('accepted'));
      renderPage();

      fireEvent.click(await screen.findByLabelText('Accept'));

      await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/' }));
      expect(screen.queryByTestId('share-accept-already-member-modal')).toBeNull();
    });
  });

  it('still goes home on an unmapped accept failure', async () => {
    vi.mocked(fetchInvite).mockResolvedValue(orgLink);
    acceptRejects('Something else', 500);
    renderPage();

    fireEvent.click(await screen.findByLabelText('Accept'));

    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/' }));
  });
});
