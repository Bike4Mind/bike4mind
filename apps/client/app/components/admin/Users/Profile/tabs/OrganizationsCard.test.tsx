import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { OrganizationsCard } from './OrganizationsCard';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';
import type { AdminUserProfile } from '../userProfileModel';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  currentUser: { id: 'admin-1', isAdmin: true } as { id: string; isAdmin?: boolean },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));

const USER_ID = 'test-user-1';
const ACME = '650000000000000000000aaa';
const BETA = '650000000000000000000bbb';
const GAMMA = '650000000000000000000ccc';

const orgs = [
  { id: ACME, name: 'Acme', userId: USER_ID, seats: 5, adminUserIds: [], users: [], personal: false },
  {
    id: BETA,
    name: 'Beta',
    userId: 'owner-2',
    seats: 5,
    adminUserIds: [USER_ID],
    users: [{ userId: USER_ID, permissions: ['read'] }],
    personal: false,
  },
  {
    id: GAMMA,
    name: 'Gamma',
    userId: 'owner-3',
    seats: 5,
    adminUserIds: [],
    users: [{ userId: USER_ID, permissions: ['read'] }],
    personal: false,
  },
];

const renderCard = (user: AdminUserProfile = buildProfile()) =>
  render(<OrganizationsCard user={user} />, { wrapper: ProfileTestWrapper });

const CaptureClient = ({ onClient }: { onClient: (client: QueryClient) => void }) => {
  onClient(useQueryClient());
  return null;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser = { id: 'admin-1', isAdmin: true };
  mocks.get.mockResolvedValue({ data: { data: orgs, hasMore: false, total: orgs.length } });
});

describe('OrganizationsCard', () => {
  it('lists every org with its role, a link to its admin profile and the active marker', async () => {
    renderCard(buildProfile({ organizationId: { id: BETA, name: 'Beta' } as AdminUserProfile['organizationId'] }));

    expect(await screen.findByTestId(`user-profile-org-${ACME}-row`)).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/organizations',
      expect.objectContaining({ params: expect.objectContaining({ filters: { userId: USER_ID } }) })
    );
    expect(screen.getByTestId(`user-profile-org-${ACME}-role`)).toHaveTextContent('Owner');
    expect(screen.getByTestId(`user-profile-org-${BETA}-role`)).toHaveTextContent('Manager');
    expect(screen.getByTestId(`user-profile-org-${GAMMA}-role`)).toHaveTextContent('Member');
    expect(screen.getByTestId(`user-profile-org-${BETA}-link`)).toHaveAttribute(
      'href',
      `/admin?tab=organizations&orgId=${BETA}`
    );
    expect(screen.getByTestId(`user-profile-org-${BETA}-active`)).toBeInTheDocument();
    expect(screen.queryByTestId(`user-profile-org-${ACME}-active`)).not.toBeInTheDocument();
  });

  it('opens the remove dialog for an org, blocked for the one they own', async () => {
    renderCard();

    fireEvent.click(await screen.findByTestId(`user-profile-org-${ACME}-remove-btn`));
    const dialog = await screen.findByTestId('org-remove-dialog');
    expect(within(dialog).getByTestId('org-remove-dialog-hint')).toHaveTextContent(
      'Ada Lovelace owns Acme. Transfer ownership before removing them.'
    );
  });

  it('opens the role and add dialogs', async () => {
    renderCard();

    fireEvent.click(await screen.findByTestId(`user-profile-org-${GAMMA}-role-btn`));
    expect(await screen.findByTestId('org-role-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-role-dialog-cancel-btn'));

    fireEvent.click(screen.getByTestId('user-profile-org-add-btn'));
    expect(await screen.findByTestId('org-add-dialog')).toBeInTheDocument();
  });

  it('offers the add action when the user is in no organization', async () => {
    mocks.get.mockResolvedValue({ data: { data: [], hasMore: false, total: 0 } });
    renderCard();

    expect(await screen.findByText('Not in any organization')).toBeInTheDocument();
    expect(screen.getByTestId('user-profile-org-add-btn')).toBeInTheDocument();
  });

  it('says so when the organizations fail to load', async () => {
    mocks.get.mockRejectedValue(new Error('boom'));
    renderCard();

    expect(await screen.findByText('Organizations could not be loaded.')).toBeInTheDocument();
  });

  it('keeps a loaded list visible when a refetch fails', async () => {
    let client: QueryClient | undefined;
    render(
      <>
        <CaptureClient onClient={c => (client = c)} />
        <OrganizationsCard user={buildProfile()} />
      </>,
      { wrapper: ProfileTestWrapper }
    );
    expect(await screen.findByTestId(`user-profile-org-${ACME}-row`)).toBeInTheDocument();

    mocks.get.mockRejectedValue(new Error('boom'));
    await act(async () => {
      await client?.refetchQueries({ queryKey: ['organizations'] });
    });

    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Organizations could not be loaded.')).not.toBeInTheDocument();
    expect(screen.getByTestId(`user-profile-org-${ACME}-row`)).toBeInTheDocument();
  });

  it('shows a delegated admin only the active org, since the list would be their own', async () => {
    mocks.currentUser = { id: 'admin-1' };
    renderCard(buildProfile({ organizationId: { id: BETA, name: 'Beta' } as AdminUserProfile['organizationId'] }));

    expect(screen.getByTestId(`user-profile-org-${BETA}-link`)).toHaveTextContent('Beta');
    expect(screen.queryByTestId('user-profile-org-add-btn')).not.toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
