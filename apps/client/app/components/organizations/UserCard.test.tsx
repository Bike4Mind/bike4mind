import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, IUserDocument, Permission } from '@bike4mind/common';
import i18next from 'i18next';
import en from '@client/app/locales/en.json';
import OrganizationUserCard from './UserCard';
import { MemberCreditUsage } from './memberCreditBudget';

const setOverride = vi.fn();
const setManager = vi.fn();
const viewer = vi.hoisted(() => ({ id: 'viewer' }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useRemoveMemberFromOrganization: () => ({ mutateAsync: vi.fn() }),
  useLeaveOrganization: () => ({ mutateAsync: vi.fn() }),
  useSetMemberCreditOverride: () => ({ mutateAsync: setOverride, isPending: false }),
  useSetOrganizationManager: () => ({ mutate: setManager, isPending: false }),
}));
vi.mock('@client/app/hooks/data/invites', () => ({ useCancelInvite: () => ({ mutateAsync: vi.fn() }) }));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: viewer.id, isAdmin: false } }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/utils/s3', () => ({ getAppFileUrl: () => '' }));
vi.mock('./OffboardMemberDialog', () => ({
  default: ({ member }: { member: { id: string } | null }) =>
    member ? <div data-testid="offboard-dialog" data-member-id={member.id} /> : null,
}));

// A real i18next over en.json, so the chip assertions pin the wording users see.
const i18n = vi.hoisted(() => ({ t: (key: string): string => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: i18n.t }) }));
const i18nInstance = i18next.createInstance();
void i18nInstance.init({ lng: 'en', resources: { en: { translation: en } }, initAsync: false });
i18n.t = i18nInstance.t.bind(i18nInstance) as (key: string) => string;

const appTheme = extendTheme({ ...getThemeConfig() });
const org = { id: 'org1', userId: 'owner1', maxCreditsPerMember: 500 } as unknown as IOrganizationDocument;

const member = (id: string, creditUsage: MemberCreditUsage | null, status: 'accepted' | 'pending' = 'accepted') =>
  ({ id, name: `User ${id}`, status, permissions: [Permission.read], creditUsage }) as unknown as IUserDocument & {
    status: 'accepted' | 'pending';
    permissions: Permission[];
    creditUsage: MemberCreditUsage | null;
  };

type Roster = { invite: boolean; revoke: boolean };
const renderCard = (
  user: ReturnType<typeof member>,
  canManageCreditBudgets: boolean,
  roster: boolean | Roster = false,
  {
    canManageManagers = false,
    organization = org,
  }: { canManageManagers?: boolean; organization?: IOrganizationDocument } = {}
) =>
  render(
    ((children: ReactNode) => (
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
      </QueryClientProvider>
    ))(
      <OrganizationUserCard
        organization={organization}
        user={user}
        canInviteMembers={typeof roster === 'boolean' ? roster : roster.invite}
        canRevokeMembers={typeof roster === 'boolean' ? roster : roster.revoke}
        canManageCreditBudgets={canManageCreditBudgets}
        canManageManagers={canManageManagers}
      />
    )
  );

const openMenu = () => fireEvent.click(screen.getByTestId('org-user-card-menu-btn'));

describe('OrganizationUserCard credit usage', () => {
  beforeEach(() => setOverride.mockReset().mockResolvedValue({}));

  it('shows "Not tracked" distinctly from 0 used', () => {
    renderCard(member('a', { tracked: false, used: 0, cap: 500, isOverride: false }), false);
    expect(screen.getByTestId('organization-user-card-credit-usage').textContent).toBe('Not tracked');
  });

  it('shows usage against the cap and marks a per-member override', () => {
    renderCard(member('a', { tracked: true, used: 120, cap: 50, isOverride: true }), false);
    expect(screen.getByTestId('organization-user-card-credit-usage').textContent).toBe('120 / 50(own limit)');
  });

  it('shows a dash for a pending invite and offers no limit control', () => {
    renderCard(member('a', null, 'pending'), true);
    expect(screen.getByTestId('organization-user-card-credit-usage').textContent).toBe('-');
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });
});

describe('OrganizationUserCard monthly limit control', () => {
  beforeEach(() => {
    viewer.id = 'viewer';
    setOverride.mockReset().mockResolvedValue({});
  });

  it('is hidden from a viewer who cannot manage budgets', () => {
    renderCard(member('a', { tracked: true, used: 0, cap: 500, isOverride: false }), false);
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });

  // The owner row hides every roster action, but the owner's own spend is capped like anyone's.
  it('is offered on the owner row, which has no roster actions', async () => {
    renderCard(member('owner1', { tracked: true, used: 0, cap: 500, isOverride: false }), true, true);
    openMenu();
    expect(await screen.findByText('Set monthly limit')).toBeTruthy();
    expect(screen.queryByTestId('organization-user-card-revoke-access')).toBeNull();
    expect(screen.queryByTestId('organization-user-card-cancel-invite')).toBeNull();
    fireEvent.click(screen.getByTestId('organization-user-card-set-limit'));
    expect(screen.getByTestId('credit-limit-modal')).toBeTruthy();
  });

  // The billing owner viewing their own row would satisfy canLeave, so this pins the `!isOwner` guard on it.
  it('offers the owner no Leave Team on their own row', async () => {
    viewer.id = 'owner1';
    renderCard(member('owner1', { tracked: true, used: 0, cap: 500, isOverride: false }), true, true);
    openMenu();
    expect(await screen.findByText('Set monthly limit')).toBeTruthy();
    expect(screen.queryByText('Leave Team')).toBeNull();
  });

  it('saves an override of 0 and can clear back to the org default', async () => {
    renderCard(member('a', { tracked: true, used: 10, cap: 50, isOverride: true }), true);
    openMenu();
    fireEvent.click(await screen.findByTestId('organization-user-card-set-limit'));

    fireEvent.change(screen.getByTestId('credit-limit-input'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('credit-limit-save-btn'));
    await waitFor(() =>
      expect(setOverride).toHaveBeenCalledWith({ organizationId: 'org1', userId: 'a', maxCredits: 0 })
    );

    openMenu();
    fireEvent.click(await screen.findByTestId('organization-user-card-set-limit'));
    fireEvent.click(screen.getByTestId('credit-limit-clear-btn'));
    await waitFor(() =>
      expect(setOverride).toHaveBeenLastCalledWith({ organizationId: 'org1', userId: 'a', maxCredits: null })
    );
  });
});

// Revoke Access and Cancel Invite hit endpoints with different server gates, so each follows its own flag.
describe('OrganizationUserCard roster actions', () => {
  beforeEach(() => {
    viewer.id = 'viewer';
  });

  const accepted = () => member('a', { tracked: true, used: 0, cap: 500, isOverride: false });

  it('offers Revoke Access on the revoke flag alone', async () => {
    renderCard(accepted(), false, { invite: false, revoke: true });
    openMenu();
    expect(await screen.findByTestId('organization-user-card-revoke-access')).toBeTruthy();
  });

  it('opens the offboarding dialog for that member instead of a plain confirm', async () => {
    renderCard(accepted(), false, { invite: false, revoke: true });
    expect(screen.queryByTestId('offboard-dialog')).toBeNull();
    openMenu();
    fireEvent.click(await screen.findByTestId('organization-user-card-revoke-access'));
    expect(screen.getByTestId('offboard-dialog').getAttribute('data-member-id')).toBe('a');
  });

  it('withholds Revoke Access from a viewer who may only invite', () => {
    renderCard(accepted(), false, { invite: true, revoke: false });
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });

  it('offers Cancel Invite on the invite flag alone', async () => {
    renderCard(member('p', null, 'pending'), false, { invite: true, revoke: false });
    openMenu();
    expect(await screen.findByTestId('organization-user-card-cancel-invite')).toBeTruthy();
  });

  it('withholds Cancel Invite from a viewer who may only revoke', () => {
    renderCard(member('p', null, 'pending'), false, { invite: false, revoke: true });
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });

  it('shows no menu when both invite and revoke are withheld', () => {
    renderCard(accepted(), false, { invite: false, revoke: false });
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
    renderCard(member('p', null, 'pending'), false, { invite: false, revoke: false });
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });
});

describe('OrganizationUserCard manager role', () => {
  const managedOrg = { ...org, adminUserIds: ['mgr'] } as unknown as IOrganizationDocument;
  const usage: MemberCreditUsage = { tracked: true, used: 0, cap: 500, isOverride: false };

  beforeEach(() => {
    viewer.id = 'owner1';
    setManager.mockReset();
  });

  it('shows a Manager chip in place of the sharing label', () => {
    renderCard(member('mgr', usage), false, false, { organization: managedOrg });
    expect(screen.getByTestId('organization-user-card-manager-chip').textContent).toBe('Manager');
    expect(screen.queryByText('Viewer')).toBeNull();
  });

  it('labels a plain member by team role, never by an ACL name', () => {
    renderCard(
      { ...member('a', usage), permissions: [Permission.read, Permission.update, Permission.share] },
      false,
      false,
      { organization: managedOrg }
    );
    expect(screen.getByTestId('organization-user-card-member-chip').textContent).toBe('Member');
    for (const aclLabel of ['Admin', 'Editor', 'Viewer']) expect(screen.queryByText(aclLabel)).toBeNull();
  });

  it.each([[Permission.update], [Permission.share]])(
    'flags a member whose %s permission opens team settings',
    permission => {
      renderCard({ ...member('a', usage), permissions: [Permission.read, permission] }, false, false, {
        organization: managedOrg,
      });
      expect(screen.getByTestId('organization-user-card-settings-access-chip').textContent).toBe('Can edit settings');
    }
  );

  it('does not flag a read-only member', () => {
    renderCard(member('a', usage), false, false, { organization: managedOrg });
    expect(screen.queryByTestId('organization-user-card-settings-access-chip')).toBeNull();
  });

  it('shows the Owner chip, not Manager, on the owner row', () => {
    renderCard(member('owner1', usage), false, false, {
      organization: { ...org, adminUserIds: ['owner1'] } as unknown as IOrganizationDocument,
    });
    expect(screen.getByTestId('organization-user-card-owner-chip').textContent).toBe('Owner');
    expect(screen.queryByTestId('organization-user-card-manager-chip')).toBeNull();
  });

  it('offers Make manager to the owner on a member row', async () => {
    renderCard(member('a', usage), false, false, { canManageManagers: true, organization: managedOrg });
    openMenu();
    fireEvent.click(await screen.findByTestId('organization-user-card-make-manager'));
    expect(setManager).toHaveBeenCalledWith({ organizationId: 'org1', userId: 'a', isManager: true });
  });

  it('offers Remove manager on a manager row', async () => {
    renderCard(member('mgr', usage), false, false, { canManageManagers: true, organization: managedOrg });
    openMenu();
    fireEvent.click(await screen.findByTestId('organization-user-card-remove-manager'));
    expect(setManager).toHaveBeenCalledWith({ organizationId: 'org1', userId: 'mgr', isManager: false });
  });

  it('offers no manager action to a viewer who cannot manage managers', () => {
    renderCard(member('a', usage), false, false, { organization: managedOrg });
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });

  it('offers no manager action on the owner row', async () => {
    renderCard(member('owner1', usage), true, false, { canManageManagers: true, organization: managedOrg });
    openMenu();
    expect(await screen.findByText('Set monthly limit')).toBeTruthy();
    expect(screen.queryByTestId('organization-user-card-make-manager')).toBeNull();
  });

  it('withholds Make manager from a deactivated member', () => {
    renderCard({ ...member('a', usage), isBanned: true }, false, false, {
      canManageManagers: true,
      organization: managedOrg,
    });
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });

  it('still offers Remove manager on a deactivated manager', async () => {
    renderCard({ ...member('mgr', usage), isBanned: true }, false, false, {
      canManageManagers: true,
      organization: managedOrg,
    });
    openMenu();
    expect(await screen.findByTestId('organization-user-card-remove-manager')).toBeTruthy();
  });

  it('withholds Make manager from a row whose permissions confer no membership', () => {
    renderCard({ ...member('a', usage), permissions: [] }, false, false, {
      canManageManagers: true,
      organization: managedOrg,
    });
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });

  it('offers no manager action on a pending invite', () => {
    renderCard(member('p', null, 'pending'), false, false, { canManageManagers: true, organization: managedOrg });
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });
});
