import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, IUserDocument, Permission } from '@bike4mind/common';
import OrganizationUserCard from './UserCard';
import { MemberCreditUsage } from './memberCreditBudget';

const setOverride = vi.fn();
const viewer = vi.hoisted(() => ({ id: 'viewer' }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useRemoveMemberFromOrganization: () => ({ mutateAsync: vi.fn() }),
  useLeaveOrganization: () => ({ mutateAsync: vi.fn() }),
  useSetMemberCreditOverride: () => ({ mutateAsync: setOverride, isPending: false }),
}));
vi.mock('@client/app/hooks/data/invites', () => ({ useCancelInvite: () => ({ mutateAsync: vi.fn() }) }));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: viewer.id, isAdmin: false } }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/utils/s3', () => ({ getAppFileUrl: () => '' }));

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
  roster: boolean | Roster = false
) =>
  render(
    ((children: ReactNode) => (
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
      </QueryClientProvider>
    ))(
      <OrganizationUserCard
        organization={org}
        user={user}
        canInviteMembers={typeof roster === 'boolean' ? roster : roster.invite}
        canRevokeMembers={typeof roster === 'boolean' ? roster : roster.revoke}
        canManageCreditBudgets={canManageCreditBudgets}
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
