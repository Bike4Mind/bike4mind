import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, Permission } from '@bike4mind/common';
import OrganizationMembers from './Member';

const mocks = vi.hoisted(() => ({
  viewerId: 'viewer',
  viewer: undefined as { id: string; isAdmin: boolean } | null | undefined,
  members: [] as { id: string; name: string }[],
  pending: [] as { id: string; name: string }[],
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
  useGetUsers: () => ({ data: undefined, isFetching: false }),
}));
vi.mock('@client/app/hooks/data/invites', () => ({ useShareDocument: () => ({ mutate: vi.fn() }) }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useOrganizationSeats: () => mocks.seats,
  useSetMemberCreditDefault: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./UserCard', () => ({
  default: (p: { user: { id: string }; canInviteMembers: boolean; canRevokeMembers: boolean }) => (
    <div
      data-testid={`member-card-${p.user.id}`}
      data-invite={String(p.canInviteMembers)}
      data-revoke={String(p.canRevokeMembers)}
    />
  ),
}));
vi.mock('@client/app/components/common/GenericAddItemsModal', () => ({
  default: () => <div data-testid="member-add-modal" />,
}));
vi.mock('@client/app/components/common/UserCard', () => ({ default: () => null }));

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
    renderMembers(
      buildOrg({ users: [{ userId: 'viewer', permissions: [Permission.read] }] as IOrganizationDocument['users'] })
    );
    expect(screen.queryByTestId('member-credit-budget-edit-btn')).toBeNull();
  });

  it('is hidden from a listed admin who no longer has a users[] row', () => {
    renderMembers(buildOrg({ adminUserIds: ['viewer'] }));
    expect(screen.queryByTestId('member-credit-budget-edit-btn')).toBeNull();
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

  it('gives a manager without an admin row Revoke but not Add or Cancel Invite', () => {
    renderMembers(buildOrg({ managerId: 'viewer' }));
    expectControls({ invite: false, revoke: true });
  });

  it('gives an appointed admin with a users[] row Add and Cancel Invite but not Revoke', () => {
    renderMembers(
      buildOrg({
        adminUserIds: ['viewer'],
        users: [{ userId: 'viewer', permissions: [Permission.read] }] as IOrganizationDocument['users'],
      })
    );
    expectControls({ invite: true, revoke: false });
  });

  it('gives a stale appointed admin with no users[] row nothing', () => {
    renderMembers(buildOrg({ adminUserIds: ['viewer'] }));
    expectControls({ invite: false, revoke: false });
  });

  // The appointment route could persist an admin row with no permissions; isOrgMember rejects it
  // before the invite routes reach the admin check.
  it('gives an appointed admin whose users[] row confers no membership nothing', () => {
    renderMembers(
      buildOrg({
        adminUserIds: ['viewer'],
        users: [{ userId: 'viewer', permissions: [] }] as unknown as IOrganizationDocument['users'],
      })
    );
    expectControls({ invite: false, revoke: false });
    expect(screen.queryByTestId('organization-members-seats-card')).toBeNull();
  });

  it('gives an appointed admin whose users[] row has no permissions field nothing', () => {
    renderMembers(
      buildOrg({
        adminUserIds: ['viewer'],
        users: [{ userId: 'viewer' }] as unknown as IOrganizationDocument['users'],
      })
    );
    expectControls({ invite: false, revoke: false });
  });

  it('does not treat an empty managerId as matching an empty viewer id', () => {
    mocks.viewer = { id: '', isAdmin: false };
    renderMembers(buildOrg({ managerId: '' }));
    expectControls({ invite: false, revoke: false });
  });

  it('does not grant Revoke on a null managerId', () => {
    renderMembers(buildOrg({ managerId: null } as unknown as Partial<IOrganizationDocument>));
    expectControls({ invite: false, revoke: false });
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

  it('shows the seat card, but no Add Member button, to a manager without an admin row', () => {
    mocks.seats = { maxSeats: 1, currentSeats: 1, availableSeats: 0 };
    renderMembers(buildOrg({ managerId: 'viewer' }));
    expect(screen.getByTestId('organization-members-seats-card')).toBeTruthy();
    expect(screen.queryByTestId('organization-members-add-no-seats-btn')).toBeNull();
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
