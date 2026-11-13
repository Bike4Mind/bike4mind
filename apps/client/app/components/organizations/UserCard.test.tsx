import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, Permission } from '@bike4mind/common';
import i18next from 'i18next';
import en from '@client/app/locales/en.json';
import OrganizationUserCard, { OrganizationRosterRow } from './UserCard';
import { MemberCreditUsage } from './memberCreditBudget';
import { MemberRole } from './memberRosterView';

const setOverride = vi.fn();
const setManager = vi.fn();
const resend = vi.fn();
const viewer = vi.hoisted(() => ({ id: 'viewer' }));
const hooks = vi.hoisted(() => ({
  confirm: vi.fn(),
  removeMember: vi.fn(),
  leave: vi.fn(),
  cancelInvite: vi.fn(),
  navigate: vi.fn(),
  isMobile: false,
  cancelOptions: undefined as { onSuccess: () => void; onError: (err: Error) => void } | undefined,
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useRemoveMemberFromOrganization: () => ({ mutateAsync: hooks.removeMember }),
  useLeaveOrganization: () => ({ mutateAsync: hooks.leave }),
  useSetMemberCreditOverride: () => ({ mutateAsync: setOverride, isPending: false }),
  useSetOrganizationManager: () => ({ mutate: setManager, isPending: false }),
  useResendOrganizationInvite: () => ({ mutate: resend, isPending: false }),
}));
vi.mock('@client/app/hooks/data/invites', () => ({
  useCancelInvite: (options: { onSuccess: () => void; onError: (err: Error) => void }) => {
    hooks.cancelOptions = options;
    return { mutateAsync: hooks.cancelInvite };
  },
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => hooks.confirm }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: viewer.id, isAdmin: false } }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => hooks.isMobile }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => hooks.navigate }));
vi.mock('@client/app/utils/s3', () => ({ getAppFileUrl: ({ key }: { key: string }) => `https://files.test/${key}` }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));
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
const org = {
  id: 'org1',
  name: 'Acme',
  userId: 'owner1',
  maxCreditsPerMember: 500,
} as unknown as IOrganizationDocument;

const defaultRole = (id: string): MemberRole => (id === 'owner1' ? 'owner' : id === 'mgr' ? 'manager' : 'member');

const member = (
  id: string,
  creditUsage: MemberCreditUsage | null,
  status: 'accepted' | 'pending' = 'accepted',
  role: MemberRole = defaultRole(id)
) =>
  ({
    id,
    name: `User ${id}`,
    email: `${id}@example.test`,
    status,
    role,
    permissions: [Permission.read],
    creditUsage,
  }) as unknown as OrganizationRosterRow;

type Roster = { invite: boolean; revoke: boolean };
const renderCard = (
  user: ReturnType<typeof member>,
  canManageCreditBudgets: boolean,
  roster: boolean | Roster = false,
  {
    canManageManagers = false,
    organization = org,
    selectable = false,
    selected = false,
    onToggleSelect,
  }: {
    canManageManagers?: boolean;
    organization?: IOrganizationDocument;
    selectable?: boolean;
    selected?: boolean;
    onToggleSelect?: () => void;
  } = {}
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
        selectable={selectable}
        selected={selected}
        onToggleSelect={onToggleSelect}
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

  it('explains the dash for a pending invite and offers no limit control', () => {
    renderCard(member('a', null, 'pending'), true);
    expect(screen.getByTestId('organization-user-card-credit-usage').textContent).toBe(
      '-No usage yet: this invite is still pending'
    );
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });

  it('explains the dash for an active member whose usage the viewer may not see', async () => {
    renderCard(member('a', null), false);
    const dash = screen.getByTestId('organization-user-card-credit-usage');
    expect(dash.textContent).toBe('-Only team managers can see member usage');
    fireEvent.mouseOver(dash);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Only team managers can see member usage');
  });

  it('greys an untracked member and shows uncapped usage plainly', () => {
    renderCard(member('a', { tracked: true, used: 7, cap: null, isOverride: false }), false);
    expect(screen.getByTestId('organization-user-card-credit-usage').textContent).toBe('7');
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
    expect(screen.queryByTestId('organization-user-card-remove-member')).toBeNull();
    expect(screen.queryByTestId('organization-user-card-cancel-invite')).toBeNull();
    fireEvent.click(screen.getByTestId('organization-user-card-set-limit'));
    expect(screen.getByTestId('credit-limit-modal')).toBeTruthy();
  });

  it('describes an unlimited team default', async () => {
    renderCard(member('a', { tracked: true, used: 0, cap: null, isOverride: false }), true, false, {
      organization: { ...org, maxCreditsPerMember: null } as unknown as IOrganizationDocument,
    });
    openMenu();
    fireEvent.click(await screen.findByTestId('organization-user-card-set-limit'));
    expect(screen.getByText('Overrides the team default, which is currently no limit.')).toBeTruthy();
  });

  // The billing owner viewing their own row would satisfy canLeave, so this pins the `!isOwner` guard on it.
  it('offers the owner no Leave Team on their own row', async () => {
    viewer.id = 'owner1';
    renderCard(member('owner1', { tracked: true, used: 0, cap: 500, isOverride: false }), true, true);
    openMenu();
    expect(await screen.findByText('Set monthly limit')).toBeTruthy();
    expect(screen.queryByTestId('organization-user-card-leave')).toBeNull();
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

// Remove member and Cancel invite hit endpoints with different server gates, so each follows its own flag.
describe('OrganizationUserCard roster actions', () => {
  beforeEach(() => {
    viewer.id = 'viewer';
  });

  const accepted = () => member('a', { tracked: true, used: 0, cap: 500, isOverride: false });

  it('offers Remove member on the revoke flag alone', async () => {
    renderCard(accepted(), false, { invite: false, revoke: true });
    openMenu();
    expect(await screen.findByTestId('organization-user-card-remove-member')).toBeTruthy();
  });

  it('opens the offboarding dialog for that member instead of a plain confirm', async () => {
    renderCard(accepted(), false, { invite: false, revoke: true });
    expect(screen.queryByTestId('offboard-dialog')).toBeNull();
    openMenu();
    fireEvent.click(await screen.findByTestId('organization-user-card-remove-member'));
    expect(screen.getByTestId('offboard-dialog').getAttribute('data-member-id')).toBe('a');
  });

  it('withholds Remove member from a viewer who may only invite', () => {
    renderCard(accepted(), false, { invite: true, revoke: false });
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });

  it('offers Cancel Invite on the invite flag alone', async () => {
    renderCard(member('p', null, 'pending'), false, { invite: true, revoke: false });
    openMenu();
    expect(await screen.findByTestId('organization-user-card-cancel-invite')).toBeTruthy();
  });

  it('resends a pending invite by user id', async () => {
    renderCard(member('p', null, 'pending'), false, { invite: true, revoke: false });
    openMenu();
    const resendAction = await screen.findByTestId('organization-user-card-resend-invite');
    expect(resendAction.getAttribute('aria-label')).toContain('Resend invitation to ');
    fireEvent.click(resendAction);
    expect(resend).toHaveBeenCalledWith({ userId: 'p' });
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

  it('flags a member whose update permission opens team settings', () => {
    renderCard({ ...member('a', usage), permissions: [Permission.read, Permission.update] }, false, false, {
      organization: managedOrg,
    });
    expect(screen.getByTestId('organization-user-card-settings-access-chip').textContent).toBe('Can edit settings');
  });

  it('does not flag a share-only member', () => {
    renderCard({ ...member('a', usage), permissions: [Permission.read, Permission.share] }, false, false, {
      organization: managedOrg,
    });
    expect(screen.queryByTestId('organization-user-card-settings-access-chip')).toBeNull();
  });

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

type ConfirmArgs = {
  title: string;
  description: string;
  type?: string;
  okLabel?: string;
  cancelLabel?: string;
  onOk: () => Promise<void>;
};
const lastConfirm = () => hooks.confirm.mock.calls.at(-1)?.[0] as ConfirmArgs;

describe('OrganizationUserCard confirmations', () => {
  const usage: MemberCreditUsage = { tracked: true, used: 0, cap: 500, isOverride: false };

  beforeEach(() => {
    viewer.id = 'viewer';
    hooks.confirm.mockReset();
    hooks.removeMember.mockReset().mockResolvedValue(undefined);
    hooks.cancelInvite.mockReset().mockResolvedValue(undefined);
    hooks.leave.mockReset().mockResolvedValue(undefined);
    hooks.navigate.mockReset();
  });

  it('routes removal through offboarding without an immediate destructive call', async () => {
    renderCard(member('a', usage), false, { invite: false, revoke: true });
    openMenu();
    const item = await screen.findByTestId('organization-user-card-remove-member');
    expect(item).toHaveTextContent('Remove member');
    fireEvent.click(item);
    expect(screen.getByTestId('offboard-dialog')).toHaveAttribute('data-member-id', 'a');
    expect(hooks.confirm).not.toHaveBeenCalled();
    expect(hooks.removeMember).not.toHaveBeenCalled();
  });

  it('keeps Cancel invite neutral and names the invitee', async () => {
    renderCard(member('p', null, 'pending'), false, { invite: true, revoke: false });
    openMenu();
    const item = await screen.findByTestId('organization-user-card-cancel-invite');
    expect(item.className).not.toMatch(/danger/i);
    fireEvent.click(item);
    const args = lastConfirm();
    expect(args.type).toBeUndefined();
    expect(args.description).toContain('Cancel the invite to User p?');
    expect(args.cancelLabel).toBe('Keep invite');
    await args.onOk();
    expect(hooks.cancelInvite).toHaveBeenCalledWith({ id: 'org1', type: 'Organization', userId: 'p' });
  });

  it('reports the cancel outcome', () => {
    renderCard(member('p', null, 'pending'), false, { invite: true, revoke: false });
    hooks.cancelOptions?.onSuccess();
    expect(toasts.success).toHaveBeenCalledWith('Invite cancelled successfully');
    hooks.cancelOptions?.onError(new Error('nope'));
    expect(toasts.error).toHaveBeenCalledWith('nope');
  });

  it('offers Leave team only on your own row, behind a divider, and never Remove member there', async () => {
    viewer.id = 'a';
    renderCard(member('a', usage), true, true);
    openMenu();
    expect(await screen.findByTestId('organization-user-card-leave')).toHaveTextContent('Leave team');
    expect(screen.getByTestId('organization-user-card-leave-divider')).toBeTruthy();
    expect(screen.queryByTestId('organization-user-card-remove-member')).toBeNull();
    fireEvent.click(screen.getByTestId('organization-user-card-leave'));
    const args = lastConfirm();
    expect(args.title).toBe('Leave team');
    expect(args.description).toContain('Leave Acme?');
    await args.onOk();
    expect(hooks.leave).toHaveBeenCalledWith({ organizationId: 'org1' });
    expect(hooks.navigate).toHaveBeenCalledWith({ to: '/organizations' });
  });

  it('shows Leave team alone, without a divider, when it is the only action', async () => {
    viewer.id = 'a';
    renderCard(member('a', usage), false, false);
    openMenu();
    expect(await screen.findByTestId('organization-user-card-leave')).toBeTruthy();
    expect(screen.queryByTestId('organization-user-card-leave-divider')).toBeNull();
  });

  it('offers no Leave team on another member row', async () => {
    renderCard(member('a', usage), false, true);
    openMenu();
    expect(await screen.findByTestId('organization-user-card-remove-member')).toBeTruthy();
    expect(screen.queryByTestId('organization-user-card-leave')).toBeNull();
  });

  it('offers no Leave team on your own pending row', () => {
    viewer.id = 'p';
    renderCard(member('p', null, 'pending'), false, false);
    expect(screen.queryByTestId('org-user-card-menu-btn')).toBeNull();
  });
});

describe('OrganizationUserCard row content', () => {
  const usage: MemberCreditUsage = { tracked: true, used: 0, cap: 500, isOverride: false };

  beforeEach(() => {
    viewer.id = 'viewer';
    hooks.isMobile = false;
  });

  it('labels the row menu with the member name', () => {
    renderCard(member('a', usage), true);
    expect(screen.getByTestId('org-user-card-menu-btn')).toHaveAttribute('aria-label', 'Actions for User a');
  });

  it('shows email and role columns', () => {
    renderCard(member('a', usage, 'accepted', 'member'), false);
    expect(screen.getByTestId('organization-user-card-email')).toHaveTextContent('a@example.test');
    expect(screen.getByTestId('organization-user-card-member-chip')).toHaveTextContent('Member');
  });

  it('shows Pending and Deactivated chips and the avatar photo', () => {
    renderCard({ ...member('p', null, 'pending'), isBanned: true, photoUrl: 'me.png' }, false);
    expect(screen.getByTestId('organization-user-card-pending-chip')).toBeTruthy();
    expect(screen.getByText('Deactivated')).toBeTruthy();
    expect(document.querySelector('img')).toHaveAttribute('src', 'https://files.test/me.png');
  });

  it('shows last active as a relative time with the full timestamp on hover', () => {
    const lastActiveAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    renderCard({ ...member('a', usage), lastActiveAt }, false);
    const cell = screen.getByTestId('organization-user-card-last-active');
    expect(cell).toHaveTextContent('3d ago');
    expect(cell.getAttribute('title')).toMatch(/^Last active /);
  });

  it('explains a missing last active value', () => {
    renderCard(member('a', usage), false);
    expect(screen.getByTestId('organization-user-card-last-active').textContent).toBe('-No activity recorded');
  });

  it('renders a labelled checkbox when the row is selectable', () => {
    const onToggleSelect = vi.fn();
    renderCard(member('a', usage), false, false, { selectable: true, selected: true, onToggleSelect });
    const box = screen.getByTestId('organization-user-card-select');
    expect(box).toHaveAttribute('aria-label', 'Select User a');
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(onToggleSelect).toHaveBeenCalled();
  });

  it('leaves the selection cell empty for a row that cannot be selected', () => {
    renderCard(member('owner1', usage), false, false, { selectable: true });
    expect(screen.queryByTestId('organization-user-card-select')).toBeNull();
  });

  it('closes the monthly limit modal', async () => {
    renderCard(member('a', usage), true);
    openMenu();
    fireEvent.click(await screen.findByTestId('organization-user-card-set-limit'));
    const modal = screen.getByTestId('credit-limit-modal');
    fireEvent.click(within(modal).getByText('Cancel'));
    await waitFor(() => expect(screen.queryByTestId('credit-limit-modal')).toBeNull());
  });

  describe('on mobile', () => {
    beforeEach(() => {
      hooks.isMobile = true;
    });

    it('stacks name, email, role and usage with the menu and checkbox', () => {
      renderCard(member('a', usage), true, false, { selectable: true, onToggleSelect: vi.fn() });
      expect(screen.getByTestId('organization-user-card-email')).toHaveTextContent('a@example.test');
      expect(screen.getByTestId('organization-user-card-member-chip')).toBeTruthy();
      expect(screen.getByTestId('organization-user-card-select')).toBeTruthy();
      expect(screen.getByTestId('org-user-card-menu-btn')).toBeTruthy();
    });

    it('omits the email line when there is none', () => {
      renderCard({ ...member('a', usage), email: null } as unknown as OrganizationRosterRow, false);
      expect(screen.queryByTestId('organization-user-card-email')).toBeNull();
    });
  });
});
