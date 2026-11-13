import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, Permission } from '@bike4mind/common';
import OrganizationMembers from './Member';
vi.mock('./OrganizationMfaPolicy', () => ({ default: () => null }));

const mocks = vi.hoisted(() => ({
  share: vi.fn(),
  search: vi.fn(),
  cancel: vi.fn(),
  resend: vi.fn(),
  invitations: [] as { id: string; recipients: { pending: string[] }; permissions?: string[] }[],
  viewerId: 'viewer',
  viewer: undefined as { id: string; isAdmin: boolean } | null | undefined,
  members: [] as { id: string; name: string }[],
  pending: [] as { id: string; name: string }[],
  searchUsers: [] as { id: string; name: string; username?: string; pendingInvite?: boolean }[],
  seats: { maxSeats: 0, currentSeats: 0, availableSeats: 0 },
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({
    currentUser: mocks.viewer === undefined ? { id: mocks.viewerId, isAdmin: false } : (mocks.viewer ?? undefined),
  }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetOrganizationUsers: () => ({ data: mocks.members }),
  useGetPendingOrganizationUsers: () => ({ data: mocks.pending }),
  useGetUsers: (parameters: unknown) => {
    mocks.search(parameters);
    return { data: { users: mocks.searchUsers }, isFetching: false };
  },
}));
vi.mock('@client/app/hooks/data/invites', () => ({
  useShareDocument: () => ({ mutate: mocks.share, isPending: false }),
  useCancelInvite: () => ({ mutate: mocks.cancel, isPending: false }),
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useOrganizationSeats: () => mocks.seats,
  useOrganizationInvites: () => ({ data: mocks.invitations, isError: false }),
  useResendOrganizationInvite: () => ({ mutate: mocks.resend, isPending: false }),
  useSetMemberCreditDefault: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('./InviteLinksPanel', () => ({ default: () => null }));
vi.mock('./BulkInviteModal', () => ({
  default: (p: { availableSeats: number; onDone: () => void }) => (
    <div data-testid="bulk-invite-modal" data-seats={p.availableSeats}>
      <button onClick={p.onDone}>close</button>
    </div>
  ),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./UserCard', () => ({
  default: (p: {
    user: { id: string; creditUsage: { used: number } | null; permissions: string[] };
    canInviteMembers: boolean;
    canRevokeMembers: boolean;
    canManageManagers: boolean;
  }) => (
    <div
      data-testid={`member-card-${p.user.id}`}
      data-invite={String(p.canInviteMembers)}
      data-revoke={String(p.canRevokeMembers)}
      data-manage-managers={String(p.canManageManagers)}
      data-credit-usage={p.user.creditUsage?.used ?? 'hidden'}
      data-permissions={p.user.permissions.join(',')}
    />
  ),
}));
vi.mock('@client/app/components/common/GenericAddItemsModal', () => ({
  default: (props: {
    onSearch: (term: string) => void;
    renderNoResults?: (term: string) => ReactNode;
    leftGridContent?: ReactNode;
    items: { id: string; name: string; username: string }[];
    selectedIds: string[];
    onSelectIds: (ids: string[]) => void;
    onAdd: (ids: string[]) => void;
    renderItem: (
      user: { id: string; name: string; username: string },
      selected: boolean,
      onSelect: () => void
    ) => ReactNode;
  }) => (
    <div data-testid="member-add-modal">
      {props.leftGridContent}
      <button data-testid="search-email" onClick={() => props.onSearch('new@example.test')}>
        Search
      </button>
      {props.items.map(user => (
        <div key={user.id}>
          {props.renderItem(user, props.selectedIds.includes(user.id), () => props.onSelectIds([user.id]))}
        </div>
      ))}
      <button data-testid="add-selected" onClick={() => props.onAdd(props.selectedIds)}>
        Add selected
      </button>
      {props.renderNoResults?.('new@example.test')}
    </div>
  ),
}));
vi.mock('@client/app/components/common/UserCard', () => ({
  default: (props: { user: { id: string }; inviteStatus?: string; onClick?: () => void }) => (
    <button
      data-testid={`candidate-${props.user.id}`}
      data-invite-status={props.inviteStatus ?? 'none'}
      disabled={!props.onClick}
      onClick={props.onClick}
    >
      Candidate
    </button>
  ),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const buildOrg = (overrides: Partial<IOrganizationDocument>) =>
  ({
    id: 'org1',
    userId: 'owner1',
    adminUserIds: [],
    users: [],
    userDetails: [],
    maxCreditsPerMember: 500,
    ...overrides,
  }) as unknown as IOrganizationDocument;

const renderMembers = (organization: IOrganizationDocument) =>
  render(<OrganizationMembers organization={organization} />, {
    wrapper: TestWrapper,
  });

describe('OrganizationMembers credit budget control', () => {
  beforeEach(() => {
    mocks.viewerId = 'viewer';
    mocks.viewer = undefined;
    mocks.members = [];
    mocks.pending = [];
    mocks.searchUsers = [];
    mocks.invitations = [];
    mocks.seats = { maxSeats: 0, currentSeats: 0, availableSeats: 0 };
  });

  it('is offered to an appointed admin who holds a read-only users[] row', () => {
    renderMembers(
      buildOrg({
        adminUserIds: ['viewer'],
        users: [{ userId: 'viewer', permissions: [Permission.read] }] as IOrganizationDocument['users'],
      })
    );
    expect(screen.getByTestId('member-credit-budget-edit-btn')).toBeTruthy();
  });

  it('is hidden from a plain member', () => {
    mocks.members = [{ id: 'm1', name: 'Member One' }];
    renderMembers(
      buildOrg({
        users: [{ userId: 'viewer', permissions: [Permission.read] }] as IOrganizationDocument['users'],
        userDetails: [
          { id: 'm1', name: 'Member One', usedCredits: 20, maxCredits: 50 },
        ] as IOrganizationDocument['userDetails'],
      })
    );
    expect(screen.queryByTestId('member-credit-budget-edit-btn')).toBeNull();
    expect(screen.getByTestId('member-card-m1').getAttribute('data-credit-usage')).toBe('hidden');
  });

  it('is hidden from a listed admin who no longer has a users[] row', () => {
    renderMembers(buildOrg({ adminUserIds: ['viewer'] }));
    expect(screen.queryByTestId('member-credit-budget-edit-btn')).toBeNull();
  });

  it.each([
    ['owner', 'owner1', false, [], []],
    ['manager', 'viewer', false, ['viewer'], [{ userId: 'viewer', permissions: [Permission.read] }]],
    ['platform admin', 'viewer', true, [], []],
  ])('keeps the %s member credits display', (_role, id, isAdmin, adminUserIds, users) => {
    mocks.viewer = { id, isAdmin };
    mocks.members = [{ id: 'm1', name: 'Member One' }];
    renderMembers(
      buildOrg({
        adminUserIds,
        users: users as IOrganizationDocument['users'],
        userDetails: [
          { id: 'm1', name: 'Member One', usedCredits: 20, maxCredits: 50, periodStart: new Date() },
        ] as IOrganizationDocument['userDetails'],
      })
    );
    expect(screen.getByTestId('member-card-m1').getAttribute('data-credit-usage')).toBe('20');
  });
});

const shareUpdateRow = (userId: string) => ({
  userId,
  permissions: [Permission.read, Permission.share, Permission.update],
});

// Each control must match the server predicate behind its own endpoint: invites (Add Member, Cancel Invite)
// gate on isOrgMember then isOrgOwnerOrCurrentAdmin, Revoke Access on canAdministerOrganization.
describe('OrganizationMembers roster controls', () => {
  beforeEach(() => {
    mocks.viewer = { id: 'viewer', isAdmin: false };
    mocks.members = [{ id: 'm1', name: 'Member One' }];
    mocks.pending = [{ id: 'p1', name: 'Pending One' }];
    mocks.searchUsers = [];
    mocks.invitations = [{ id: 'invite-p1', recipients: { pending: ['p1'] } }];
    mocks.seats = { maxSeats: 0, currentSeats: 0, availableSeats: 0 };
  });

  const expectControls = ({ invite, revoke }: { invite: boolean; revoke: boolean }) => {
    expect(screen.queryByTestId('member-add-modal') !== null).toBe(invite);
    for (const id of ['m1', 'p1']) {
      const card = screen.getByTestId(`member-card-${id}`);
      expect(card.getAttribute('data-invite')).toBe(String(invite));
      expect(card.getAttribute('data-revoke')).toBe(String(revoke));
    }
  };

  it('gives a share/update member neither Add, Cancel Invite nor Revoke', () => {
    renderMembers(
      buildOrg({ users: [shareUpdateRow('viewer'), shareUpdateRow('m1')] as IOrganizationDocument['users'] })
    );
    expectControls({ invite: false, revoke: false });
  });

  it('gives the billing owner every control', () => {
    mocks.viewer = { id: 'owner1', isAdmin: false };
    renderMembers(buildOrg({}));
    expectControls({ invite: true, revoke: true });
  });

  it('gives a manager (adminUserIds) with a users[] row every control', () => {
    renderMembers(
      buildOrg({
        adminUserIds: ['viewer'],
        users: [{ userId: 'viewer', permissions: [Permission.read] }] as IOrganizationDocument['users'],
      })
    );
    expectControls({ invite: true, revoke: true });
  });

  // revokeAccess refuses a manager removing another manager (it would edit the Managers list).
  it('withholds Revoke on another manager card from a manager', () => {
    renderMembers(
      buildOrg({
        adminUserIds: ['viewer', 'm1'],
        users: [
          { userId: 'viewer', permissions: [Permission.read] },
          { userId: 'm1', permissions: [Permission.read] },
        ] as IOrganizationDocument['users'],
      })
    );
    expect(screen.getByTestId('member-card-m1').getAttribute('data-revoke')).toBe('false');
    expect(screen.getByTestId('member-card-p1').getAttribute('data-revoke')).toBe('true');
  });

  it('gives a stale manager entry with no users[] row nothing', () => {
    renderMembers(buildOrg({ adminUserIds: ['viewer'] }));
    expectControls({ invite: false, revoke: false });
  });

  // The appointment route could persist an admin row with no permissions; isOrgMember rejects it
  // before the invite routes reach the admin check. Revoke runs canAdministerOrganization, which -
  // like isOrgOwnerOrCurrentAdmin - needs only a bare users[] row.
  it('gives a manager whose users[] row confers no membership Revoke but not Add or Cancel Invite', () => {
    renderMembers(
      buildOrg({
        adminUserIds: ['viewer'],
        users: [{ userId: 'viewer', permissions: [] }] as unknown as IOrganizationDocument['users'],
      })
    );
    expectControls({ invite: false, revoke: true });
    expect(screen.queryByTestId('organization-members-seats-card')).not.toBeNull();
  });

  it('gives a manager whose users[] row has no permissions field Revoke but not Add or Cancel Invite', () => {
    renderMembers(
      buildOrg({
        adminUserIds: ['viewer'],
        users: [{ userId: 'viewer' }] as unknown as IOrganizationDocument['users'],
      })
    );
    expectControls({ invite: false, revoke: true });
  });

  // The admin panel (admin/OrganizationsTab.tsx) renders this same component for a platform admin.
  it('gives a platform admin who is not a member every control', () => {
    mocks.viewer = { id: 'viewer', isAdmin: true };
    renderMembers(buildOrg({}));
    expectControls({ invite: true, revoke: true });
  });

  it('gives no control while the current user is unresolved', () => {
    mocks.viewer = null;
    renderMembers(buildOrg({}));
    expectControls({ invite: false, revoke: false });
  });

  it('hides the no-seats Add Member button and seat card from a share/update member', () => {
    mocks.seats = { maxSeats: 1, currentSeats: 1, availableSeats: 0 };
    renderMembers(buildOrg({ users: [shareUpdateRow('viewer')] as IOrganizationDocument['users'] }));
    expect(screen.queryByTestId('organization-members-add-no-seats-btn')).toBeNull();
    expect(screen.queryByTestId('organization-members-seats-card')).toBeNull();
  });

  it('shows the no-seats Add Member button to the owner', () => {
    mocks.viewer = { id: 'owner1', isAdmin: false };
    mocks.seats = { maxSeats: 1, currentSeats: 1, availableSeats: 0 };
    renderMembers(buildOrg({}));
    expect(screen.getByTestId('organization-members-add-no-seats-btn')).toBeTruthy();
    expect(screen.getByTestId('organization-members-seats-card')).toBeTruthy();
    expect(screen.queryByTestId('member-add-modal')).toBeNull();
  });
});

describe('OrganizationMembers email invitations', () => {
  beforeEach(() => {
    mocks.viewer = { id: 'owner1', isAdmin: false };
    mocks.members = [];
    mocks.pending = [];
    mocks.searchUsers = [];
    mocks.invitations = [];
    mocks.seats = { maxSeats: 3, currentSeats: 1, availableSeats: 2 };
    mocks.share.mockClear();
    mocks.search.mockClear();
    mocks.cancel.mockClear();
  });

  it('invites the exact email after its completed search returns no account', async () => {
    renderMembers(buildOrg({}));
    expect(screen.queryByTestId('organization-invite-by-email-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('search-email'));
    await waitFor(() => expect(screen.getByTestId('organization-invite-by-email-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('organization-invite-by-email-btn'));
    expect(mocks.share).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'org1',
        type: 'Organization',
        recipients: ['new@example.test'],
      })
    );
  });

  it('shows and cancels pending email invitations', () => {
    mocks.invitations = [{ id: 'invite1', recipients: { pending: ['new@example.test'] } }];
    renderMembers(buildOrg({}));
    expect(screen.getByTestId('organization-pending-email-invites')).toHaveTextContent('new@example.test');
    fireEvent.click(screen.getByTestId('organization-cancel-email-invite-btn'));
    expect(mocks.cancel).toHaveBeenCalledWith({ id: 'org1', type: 'Organization', email: 'new@example.test' });
  });

  it('resends a pending email invitation by address', () => {
    mocks.invitations = [{ id: 'invite1', recipients: { pending: ['new@example.test'] } }];
    renderMembers(buildOrg({}));
    fireEvent.click(screen.getByRole('button', { name: 'Resend invitation to new@example.test' }));
    expect(mocks.resend).toHaveBeenCalledWith({ email: 'new@example.test' });
  });

  it('does not offer cancellation with another inviter masked address', () => {
    mocks.invitations = [{ id: 'invite1', recipients: { pending: ['n***@example.test'] } }];
    renderMembers(buildOrg({}));
    expect(screen.getByTestId('organization-pending-email-invites')).toHaveTextContent('n***@example.test');
    expect(screen.queryByTestId('organization-cancel-email-invite-btn')).toBeNull();
    expect(screen.queryByTestId('organization-resend-email-invite-btn')).toBeNull();
  });

  it('shows a typed email invite once even after the account appears in pending users', () => {
    mocks.pending = [{ id: 'new-user', name: 'New User' }];
    mocks.invitations = [{ id: 'invite1', recipients: { pending: ['new@example.test'] } }];
    renderMembers(buildOrg({}));
    expect(screen.getByTestId('organization-pending-email-invites')).toHaveTextContent('new@example.test');
    expect(screen.queryByTestId('member-card-new-user')).toBeNull();
  });

  it('lets an existing user with only an expired legacy pending row be invited again', () => {
    mocks.pending = [{ id: 'expired-user', name: 'Expired User' }];
    mocks.searchUsers = [{ id: 'expired-user', name: 'Expired User', username: 'expired-user' }];
    renderMembers(buildOrg({}));
    const candidate = screen.getByTestId('candidate-expired-user');
    expect(candidate).toHaveAttribute('data-invite-status', 'none');
    expect(candidate).not.toBeDisabled();
    fireEvent.click(candidate);
    fireEvent.click(screen.getByTestId('add-selected'));
    expect(mocks.share).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['expired-user'] }));
  });

  it('keeps an active invitation to a registered user pending without exposing their email', () => {
    mocks.searchUsers = [{ id: 'active-user', name: 'Active User', pendingInvite: true }];
    mocks.invitations = [{ id: 'active', recipients: { pending: ['ACTIVE@EXAMPLE.TEST'] } }];
    renderMembers(buildOrg({}));
    const candidate = screen.getByTestId('candidate-active-user');
    expect(candidate).toHaveAttribute('data-invite-status', 'pending');
    expect(candidate).toBeDisabled();
  });

  it('does not offer another invitation to an already pending email', async () => {
    mocks.invitations = [{ id: 'pending', recipients: { pending: ['NEW@EXAMPLE.TEST'] } }];
    renderMembers(buildOrg({}));
    fireEvent.click(screen.getByTestId('search-email'));
    await waitFor(() => {
      expect(mocks.search).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'new@example.test', pendingInviteOrganizationId: 'org1' })
      );
    });
    expect(screen.queryByTestId('organization-invite-by-email-btn')).toBeNull();
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it('offers no email invitation when all seats are reserved', () => {
    mocks.seats = { maxSeats: 3, currentSeats: 3, availableSeats: 0 };
    renderMembers(buildOrg({}));
    expect(screen.queryByTestId('member-add-modal')).toBeNull();
    expect(screen.queryByTestId('organization-invite-by-email-btn')).toBeNull();
  });
});

// Mirrors the owner-only gate on the manager route: a manager cannot appoint or remove managers.
describe('OrganizationMembers manager controls', () => {
  beforeEach(() => {
    mocks.viewer = undefined;
    mocks.members = [{ id: 'member1', name: 'Member One' }];
    mocks.pending = [];
  });

  const org = () =>
    buildOrg({
      adminUserIds: ['admin1'],
      users: [
        { userId: 'admin1', permissions: [Permission.read] },
        { userId: 'member1', permissions: [Permission.read] },
      ],
    });

  it('are offered to the owner', () => {
    mocks.viewerId = 'owner1';
    renderMembers(org());
    expect(screen.getByTestId('member-card-member1').getAttribute('data-manage-managers')).toBe('true');
  });

  it('are offered to a platform admin', () => {
    mocks.viewer = { id: 'staff1', isAdmin: true };
    renderMembers(org());
    expect(screen.getByTestId('member-card-member1').getAttribute('data-manage-managers')).toBe('true');
  });

  it('are withheld in a personal organization', () => {
    mocks.viewerId = 'owner1';
    renderMembers({ ...org(), personal: true });
    expect(screen.getByTestId('member-card-member1').getAttribute('data-manage-managers')).toBe('false');
  });

  it('are withheld from a manager', () => {
    mocks.viewerId = 'admin1';
    renderMembers(org());
    expect(screen.getByTestId('member-card-member1').getAttribute('data-manage-managers')).toBe('false');
  });
});

describe('OrganizationMembers invite role', () => {
  beforeEach(() => {
    mocks.viewer = { id: 'owner1', isAdmin: false };
    mocks.members = [];
    mocks.pending = [];
    mocks.searchUsers = [{ id: 'candidate1', name: 'Candidate', username: 'candidate' }];
    mocks.invitations = [];
    mocks.seats = { maxSeats: 5, currentSeats: 1, availableSeats: 4 };
    mocks.share.mockClear();
  });

  const pickRole = async (label: string) => {
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: label }));
  };

  it('defaults a search-added invite to viewer', () => {
    renderMembers(buildOrg({}));
    fireEvent.click(screen.getByTestId('candidate-candidate1'));
    fireEvent.click(screen.getByTestId('add-selected'));
    expect(mocks.share).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: ['candidate1'], permissions: [Permission.read] })
    );
  });

  it('sends the picked role from the search-add path', async () => {
    renderMembers(buildOrg({}));
    await pickRole('Editor');
    fireEvent.click(screen.getByTestId('candidate-candidate1'));
    fireEvent.click(screen.getByTestId('add-selected'));
    expect(mocks.share).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: ['candidate1'], permissions: [Permission.read, Permission.update] })
    );
  });

  it('sends the picked role from the by-email path', async () => {
    mocks.searchUsers = [];
    renderMembers(buildOrg({}));
    await pickRole('Editor');
    fireEvent.click(screen.getByTestId('search-email'));
    fireEvent.click(await screen.findByTestId('organization-invite-by-email-btn'));
    expect(mocks.share).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: ['new@example.test'], permissions: [Permission.read, Permission.update] })
    );
  });

  it('offers admin to the owner', async () => {
    renderMembers(buildOrg({}));
    fireEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByRole('option', { name: 'Admin' })).toBeTruthy();
  });

  it('withholds admin from a manager', async () => {
    mocks.viewer = { id: 'manager1', isAdmin: false };
    renderMembers(
      buildOrg({
        adminUserIds: ['manager1'],
        users: [{ userId: 'manager1', permissions: [Permission.read] }] as IOrganizationDocument['users'],
      })
    );
    fireEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByRole('option', { name: 'Editor' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Admin' })).toBeNull();
  });

  it('shows a pending member the role their invite carries', () => {
    mocks.pending = [{ id: 'pending1', name: 'Pending' }];
    mocks.invitations = [
      { id: 'invite1', recipients: { pending: ['pending1'] }, permissions: [Permission.read, Permission.update] },
    ];
    renderMembers(buildOrg({}));
    expect(screen.getByTestId('member-card-pending1').getAttribute('data-permissions')).toBe('read,update');
  });
});

describe('OrganizationMembers bulk invite', () => {
  beforeEach(() => {
    mocks.viewer = { id: 'owner1', isAdmin: false };
    mocks.members = [];
    mocks.invitations = [];
    mocks.pending = [];
  });

  it('opens the bulk invite modal with the available seat count and closes it', () => {
    mocks.seats = { maxSeats: 5, currentSeats: 2, availableSeats: 3 };
    renderMembers(buildOrg({}));
    expect(screen.queryByTestId('bulk-invite-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('organization-members-bulk-invite-btn'));
    expect(screen.getByTestId('bulk-invite-modal').getAttribute('data-seats')).toBe('3');
    fireEvent.click(screen.getByText('close'));
    expect(screen.queryByTestId('bulk-invite-modal')).toBeNull();
  });

  it('closes an open team A invitation draft when the mounted route switches to team B', () => {
    mocks.seats = { maxSeats: 5, currentSeats: 2, availableSeats: 3 };
    const view = renderMembers(buildOrg({}));
    fireEvent.click(screen.getByTestId('organization-members-bulk-invite-btn'));
    expect(screen.getByTestId('bulk-invite-modal')).toBeTruthy();
    view.rerender(<OrganizationMembers organization={buildOrg({ id: 'org2' })} />);
    expect(screen.queryByTestId('bulk-invite-modal')).toBeNull();
    expect(mocks.share).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('organization-members-bulk-invite-btn'));
    expect(screen.getByTestId('bulk-invite-modal')).toBeTruthy();
  });

  it('is not offered when no seats are left', () => {
    mocks.seats = { maxSeats: 5, currentSeats: 5, availableSeats: 0 };
    renderMembers(buildOrg({}));
    expect(screen.queryByTestId('organization-members-bulk-invite-btn')).toBeNull();
  });
});
