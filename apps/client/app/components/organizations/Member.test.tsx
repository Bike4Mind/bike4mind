import { type ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, Permission } from '@bike4mind/common';
import OrganizationMembers from './Member';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  share: vi.fn(),
  confirm: vi.fn<(options: { onOk: () => Promise<void> }) => void>(),
  removeMember: vi.fn().mockResolvedValue(0),
  search: vi.fn(),
  cancel: vi.fn(),
  resend: vi.fn(),
  invitations: [] as { id: string; recipients?: { pending?: string[] }; permissions?: string[] }[],
  viewerId: 'viewer',
  viewer: undefined as { id: string; isAdmin: boolean } | null | undefined,
  members: [] as { id: string; name: string }[],
  pending: [] as { id: string; name: string }[],
  searchUsers: [] as { id: string; name: string; username?: string; email?: string; pendingInvite?: boolean }[],
  seats: { maxSeats: 0, currentSeats: 0, availableSeats: 0 },
  membersState: { isLoading: false, isError: false },
  refetch: vi.fn(),
  invitesError: false,
  searchMissing: false,
  shareOptions: undefined as { onSuccess: () => void; onError: (err: Error) => void } | undefined,
  cancelOptions: undefined as { onSuccess: () => void; onError: (err: Error) => void } | undefined,
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => mocks.confirm }));
vi.mock('sonner', () => ({ toast: mocks.toast }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, put: mocks.put } }));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({
    currentUser: mocks.viewer === undefined ? { id: mocks.viewerId, isAdmin: false } : (mocks.viewer ?? undefined),
  }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetOrganizationUsers: () => ({ data: mocks.members, ...mocks.membersState, refetch: mocks.refetch }),
  useGetPendingOrganizationUsers: () => ({ data: mocks.pending }),
  useGetUsers: (parameters: unknown) => {
    mocks.search(parameters);
    return { data: mocks.searchMissing ? undefined : { users: mocks.searchUsers }, isFetching: false };
  },
}));
vi.mock('@client/app/hooks/data/invites', () => ({
  useShareDocument: (options: typeof mocks.shareOptions) => {
    mocks.shareOptions = options;
    return { mutate: mocks.share, isPending: false };
  },
  useCancelInvite: (options: typeof mocks.cancelOptions) => {
    mocks.cancelOptions = options;
    return { mutate: mocks.cancel, isPending: false };
  },
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useOrganizationSeats: () => mocks.seats,
  useOrganizationInvites: () => ({ data: mocks.invitations, isError: mocks.invitesError }),
  useResendOrganizationInvite: () => ({ mutate: mocks.resend, isPending: false }),
  useSetMemberCreditDefault: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveMemberFromOrganization: () => ({ mutateAsync: mocks.removeMember }),
  removedMembersMessage: (kept: unknown[]) => `${kept.length} members removed`,
}));
vi.mock('./InviteLinksPanel', () => ({ default: () => null }));
vi.mock('./OrgBudgetAlertsCard', () => ({ default: () => <div data-testid="org-budget-alerts-card" /> }));
vi.mock('./MyOrgNotificationPrefsCard', () => ({ default: () => <div data-testid="org-alert-prefs-card" /> }));
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
    user: { id: string; role: string; status: string; creditUsage: { used: number } | null; permissions: string[] };
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
      data-role={p.user.role}
      data-status={p.user.status}
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
    getItemId: (user: { id: string }) => string;
    isItemDisabled: (user: { id: string }) => boolean;
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
        <div
          key={user.id}
          data-testid={`item-${props.getItemId(user)}`}
          data-disabled={String(props.isItemDisabled(user))}
        >
          {props.renderItem(user, props.selectedIds.includes(user.id), () => props.onSelectIds([user.id]))}
        </div>
      ))}
      <button data-testid="select-three" onClick={() => props.onSelectIds(['a', 'b', 'c'])}>
        Select three
      </button>
      <span data-testid="selected-count">{props.selectedIds.length}</span>
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

beforeEach(() => {
  mocks.membersState = { isLoading: false, isError: false };
  mocks.invitesError = false;
  mocks.searchMissing = false;
});

describe('OrganizationMembers credit budget control', () => {
  beforeEach(() => {
    mocks.get.mockResolvedValue({ data: { members: [] } });
    mocks.put.mockResolvedValue({ data: {} });
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
describe('OrganizationMembers org alert cards', () => {
  beforeEach(() => {
    mocks.viewerId = 'viewer';
    mocks.viewer = undefined;
    mocks.members = [];
    mocks.invitations = [];
  });

  const managerOrg = (overrides: Partial<IOrganizationDocument> = {}) =>
    buildOrg({
      adminUserIds: ['viewer'],
      users: [{ userId: 'viewer', permissions: [Permission.read] }] as IOrganizationDocument['users'],
      ...overrides,
    });

  it('shows both cards to the owner', () => {
    mocks.viewer = { id: 'owner1', isAdmin: false };
    renderMembers(buildOrg({}));
    expect(screen.getByTestId('org-budget-alerts-card')).toBeTruthy();
    expect(screen.getByTestId('org-alert-prefs-card')).toBeTruthy();
  });

  it('shows both cards to an appointed manager with a read-only users[] row', () => {
    renderMembers(managerOrg());
    expect(screen.getByTestId('org-budget-alerts-card')).toBeTruthy();
    expect(screen.getByTestId('org-alert-prefs-card')).toBeTruthy();
  });

  it('gives a platform admin the settings but no personal prefs, since they are not a recipient', () => {
    mocks.viewer = { id: 'viewer', isAdmin: true };
    renderMembers(buildOrg({}));
    expect(screen.getByTestId('org-budget-alerts-card')).toBeTruthy();
    expect(screen.queryByTestId('org-alert-prefs-card')).toBeNull();
  });

  it('shows neither card to a plain member, a stale manager, or on a personal org', () => {
    const { unmount } = renderMembers(
      buildOrg({ users: [{ userId: 'viewer', permissions: [Permission.read] }] as IOrganizationDocument['users'] })
    );
    expect(screen.queryByTestId('org-budget-alerts-card')).toBeNull();
    expect(screen.queryByTestId('org-alert-prefs-card')).toBeNull();
    unmount();

    const stale = renderMembers(buildOrg({ adminUserIds: ['viewer'] }));
    expect(screen.queryByTestId('org-alert-prefs-card')).toBeNull();
    stale.unmount();

    renderMembers(managerOrg({ personal: true }));
    expect(screen.queryByTestId('org-budget-alerts-card')).toBeNull();
    expect(screen.queryByTestId('org-alert-prefs-card')).toBeNull();
  });
});

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

describe('OrganizationMembers roster wiring', () => {
  beforeEach(() => {
    mocks.viewer = { id: 'owner1', isAdmin: false };
    mocks.members = [
      { id: 'owner1', name: 'Owner' },
      { id: 'e1', name: 'Member One' },
    ];
    mocks.pending = [{ id: 'p1', name: 'Pending One' }];
    mocks.invitations = [{ id: 'invite-p1', recipients: { pending: ['p1'] } }];
    mocks.membersState = { isLoading: false, isError: false };
    mocks.refetch.mockReset();
  });

  it('derives each row role and status from the organization', () => {
    renderMembers(
      buildOrg({
        users: [{ userId: 'e1', permissions: [Permission.read, Permission.update] }] as IOrganizationDocument['users'],
      })
    );
    expect(screen.getByTestId('member-card-owner1')).toHaveAttribute('data-role', 'owner');
    expect(screen.getByTestId('member-card-e1')).toHaveAttribute('data-role', 'member');
    expect(screen.getByTestId('member-card-p1')).toHaveAttribute('data-role', 'member');
    expect(screen.getByTestId('member-card-p1')).toHaveAttribute('data-status', 'pending');
  });

  it('retries a failed member load', () => {
    mocks.membersState = { isLoading: false, isError: true };
    renderMembers(buildOrg({}));
    fireEvent.click(screen.getByTestId('organization-members-retry-btn'));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('shows the loading state while members load', () => {
    mocks.membersState = { isLoading: true, isError: false };
    renderMembers(buildOrg({}));
    expect(screen.getByTestId('organization-members-loading')).toBeTruthy();
  });

  it('builds an empty roster when no member data has arrived', () => {
    mocks.members = undefined as unknown as typeof mocks.members;
    mocks.pending = undefined as unknown as typeof mocks.pending;
    renderMembers(buildOrg({}));
    expect(screen.getByTestId('organization-members-empty')).toBeTruthy();
  });
});

describe('OrganizationMembers invite plumbing', () => {
  beforeEach(() => {
    mocks.viewer = { id: 'owner1', isAdmin: false };
    mocks.members = [];
    mocks.pending = [];
    mocks.searchUsers = [];
    mocks.invitations = [];
    mocks.invitesError = false;
    mocks.searchMissing = false;
    mocks.membersState = { isLoading: false, isError: false };
    mocks.seats = { maxSeats: 4, currentSeats: 1, availableSeats: 2 };
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
  });

  it('reports invite and cancel outcomes', () => {
    renderMembers(buildOrg({}));
    act(() => mocks.shareOptions?.onSuccess());
    expect(mocks.toast.success).toHaveBeenCalledWith('organizations.modals.members.invited');
    mocks.shareOptions?.onError(new Error('share failed'));
    expect(mocks.toast.error).toHaveBeenCalledWith('share failed');
    mocks.cancelOptions?.onSuccess();
    expect(mocks.toast.success).toHaveBeenCalledWith('Invitation cancelled');
    mocks.cancelOptions?.onError(new Error('cancel failed'));
    expect(mocks.toast.error).toHaveBeenCalledWith('cancel failed');
  });

  it('refuses a selection larger than the free seats', () => {
    renderMembers(buildOrg({}));
    fireEvent.click(screen.getByTestId('select-three'));
    expect(mocks.toast.error).toHaveBeenCalledWith('You can only add up to 2 more members with your current plan');
    expect(screen.getByTestId('selected-count')).toHaveTextContent('0');
  });

  it('allows any selection on an unlimited plan', () => {
    mocks.seats = { maxSeats: 0, currentSeats: 1, availableSeats: 0 };
    renderMembers(buildOrg({}));
    fireEvent.click(screen.getByTestId('select-three'));
    expect(screen.getByTestId('selected-count')).toHaveTextContent('3');
  });

  it.each([
    [{ maxSeats: 4, currentSeats: 3, availableSeats: 1 }, '1 seats available'],
    [{ maxSeats: 10, currentSeats: 9, availableSeats: 1 }, '1 seats available'],
  ])('shows the seat chip for %o', (seats, text) => {
    mocks.seats = seats;
    renderMembers(buildOrg({}));
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('explains a full plan when Add Member is pressed', () => {
    mocks.seats = { maxSeats: 1, currentSeats: 1, availableSeats: 0 };
    renderMembers(buildOrg({}));
    fireEvent.click(screen.getByTestId('organization-members-add-no-seats-btn'));
    expect(mocks.toast.error).toHaveBeenCalledWith('organizations.errors.no_seats');
  });

  it('says when pending invitations fail to load', () => {
    mocks.invitesError = true;
    renderMembers(buildOrg({}));
    expect(screen.getByTestId('organization-pending-invites-error')).toBeTruthy();
  });

  it('tolerates invites without recipients and a missing search result', () => {
    mocks.invitations = [{ id: 'blank' }, { id: 'empty', recipients: {} }];
    mocks.searchMissing = true;
    renderMembers(buildOrg({}));
    expect(screen.queryByTestId('organization-pending-email-invites')).toBeNull();
  });

  it('renders before pending invitations have loaded', () => {
    mocks.invitations = undefined as unknown as typeof mocks.invitations;
    mocks.pending = [{ id: 'p1', name: 'Pending One' }];
    renderMembers(buildOrg({}));
    expect(screen.getByTestId('member-card-p1')).toBeTruthy();
  });

  it('keeps an accepted member accepted when an old invite still lists them', () => {
    mocks.invitations = [{ id: 'old', recipients: { pending: ['m1'] } }];
    mocks.searchUsers = [{ id: 'm1', name: 'Member One' }];
    renderMembers(
      buildOrg({ users: [{ userId: 'm1', permissions: [Permission.read] }] as IOrganizationDocument['users'] })
    );
    expect(screen.getByTestId('candidate-m1')).toHaveAttribute('data-invite-status', 'accepted');
  });

  it('marks candidates already invited by email or username, and hides the owner', () => {
    mocks.invitations = [{ id: 'i1', recipients: { pending: ['MAIL@EXAMPLE.TEST', 'handle'] } }];
    mocks.searchUsers = [
      { id: 'owner1', name: 'Owner' },
      { id: 'by-mail', name: 'By Mail', email: 'mail@example.test' },
      { id: 'by-handle', name: 'By Handle', username: 'handle' },
      { id: 'fresh', name: 'Fresh' },
    ];
    renderMembers(buildOrg({}));
    expect(screen.queryByTestId('item-owner1')).toBeNull();
    expect(screen.getByTestId('item-by-mail')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('item-by-handle')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('item-fresh')).toHaveAttribute('data-disabled', 'false');
  });

  it.each([
    ['falls back to the viewer as owner', { id: 'owner1', isAdmin: false }],
    ['has no owner while the viewer is unresolved', null],
  ])('%s when the org has no owner id', (_label, viewer) => {
    mocks.viewer = viewer;
    mocks.searchUsers = [{ id: 'owner1', name: 'Viewer' }];
    renderMembers(buildOrg({ userId: undefined }));
    // Only the add modal (owner path) renders candidates; the unresolved viewer gets no modal.
    expect(screen.queryByTestId('item-owner1')).toBeNull();
  });
});

describe('OrganizationMembers organization identity', () => {
  it('requires a fresh selection after switching between loaded teams with a shared member', async () => {
    mocks.viewerId = 'viewer';
    mocks.viewer = undefined;
    mocks.members = [{ id: 'shared', name: 'Shared Member' }];
    mocks.pending = [];
    mocks.invitations = [];
    mocks.membersState = { isLoading: false, isError: false };
    mocks.removeMember.mockClear();
    mocks.confirm.mockClear();
    const organizationA = buildOrg({
      id: 'team-a',
      userId: 'viewer',
      users: [{ userId: 'shared', permissions: [Permission.read] }] as IOrganizationDocument['users'],
    });
    const organizationB = { ...organizationA, id: 'team-b' } as IOrganizationDocument;
    const view = renderMembers(organizationA);
    fireEvent.click(screen.getByTestId('organization-members-select-all'));
    expect(screen.getByTestId('organization-members-bulk-bar')).toHaveTextContent('1 selected');

    view.rerender(<OrganizationMembers organization={organizationB} />);
    expect(screen.queryByTestId('organization-members-bulk-bar')).toBeNull();
    expect(screen.getByTestId('organization-members-select-all')).not.toBeChecked();
    expect(mocks.removeMember).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('organization-members-select-all'));
    fireEvent.click(screen.getByTestId('organization-members-remove-selected-btn'));
    const confirmation = mocks.confirm.mock.calls.at(-1)?.[0];
    if (!confirmation) throw new Error('Missing bulk removal confirmation');
    await act(async () => confirmation.onOk());
    expect(mocks.removeMember).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'team-b',
      userId: 'shared',
      quiet: true,
    });
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
    fireEvent.click(within(screen.getByTestId('organization-members-role-select')).getByRole('combobox'));
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
    fireEvent.click(within(screen.getByTestId('organization-members-role-select')).getByRole('combobox'));
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
    fireEvent.click(within(screen.getByTestId('organization-members-role-select')).getByRole('combobox'));
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

describe('OrganizationMembers MFA policy save ownership', () => {
  it('holds edits through the save and refetch, then the keyed policy is editable again', async () => {
    mocks.put.mockReset();
    mocks.get.mockReset();
    mocks.viewer = undefined;
    mocks.members = [];
    mocks.pending = [];
    mocks.invitations = [];
    mocks.viewerId = 'owner1';
    mocks.get.mockResolvedValue({ data: { members: [] } });
    let finishWrite: () => void = () => {
      throw new Error('Write not started');
    };
    mocks.put.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishWrite = resolve;
        })
    );
    let finishRefetch: () => void = () => {
      throw new Error('Refetch not started');
    };
    const refetch = new Promise<void>(resolve => {
      finishRefetch = resolve;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockReturnValue(refetch);
    const renderOrganization = (organization: IOrganizationDocument) => (
      <QueryClientProvider client={client}>
        <CssVarsProvider theme={appTheme}>
          <OrganizationMembers organization={organization} />
        </CssVarsProvider>
      </QueryClientProvider>
    );
    const organization = buildOrg({ mfaPolicy: { required: false, graceEndsAt: null } });
    const view = render(renderOrganization(organization));
    const user = userEvent.setup();
    const required = screen.getByTestId('organization-mfa-required');
    const grace = screen.getByTestId('organization-mfa-grace-days');
    await user.click(required);
    fireEvent.change(grace, { target: { value: '3' } });
    const save = screen.getByTestId('organization-mfa-save');
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    expect(mocks.put).toHaveBeenLastCalledWith('/api/organizations/org1/mfa-policy', { required: true, graceDays: 3 });
    expect(required).toBeDisabled();
    expect(grace).toBeDisabled();
    act(() => required.click());
    await user.type(grace, '9', { skipClick: true });
    expect(required).toBeChecked();
    expect(grace).toHaveValue(3);
    await act(async () => {
      finishWrite();
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['organizations'] });
    expect(required).toBeDisabled();
    expect(grace).toBeDisabled();
    await act(async () => {
      finishRefetch();
    });
    await waitFor(() => expect(required).not.toBeDisabled());
    view.rerender(
      renderOrganization({
        ...organization,
        mfaPolicy: { required: true, graceEndsAt: new Date('2030-01-04T00:00:00Z') },
      })
    );
    await user.click(screen.getByTestId('organization-mfa-required'));
    expect(screen.getByTestId('organization-mfa-required')).not.toBeChecked();
    mocks.put.mockResolvedValueOnce({ data: {} });
    await user.click(screen.getByTestId('organization-mfa-save'));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(2));
    expect(mocks.put).toHaveBeenLastCalledWith('/api/organizations/org1/mfa-policy', { required: false, graceDays: 7 });
  });
});
