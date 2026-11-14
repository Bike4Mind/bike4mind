import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import OrganizationSettingsSection from './OrganizationSettingsSection';

const currentUser = vi.fn();
const transfer = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const updateOrg = vi.hoisted(() => vi.fn());
const members = vi.hoisted(() => ({
  list: [] as { id: string; name: string; email?: string; isBanned?: boolean }[],
  loaded: true,
}));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useUpdateOrganization: () => ({ mutateAsync: updateOrg, isPending: false }),
  useTransferOrganizationOwnership: () => ({ mutateAsync: transfer, isPending: false }),
}));

vi.mock('@client/app/hooks/data/user', () => ({
  useGetOrganizationUsers: () => (members.loaded ? { data: members.list, isSuccess: true } : { isSuccess: false }),
}));

vi.mock('./OrganizationGeneralSection', () => ({ default: () => null }));
vi.mock('./DeleteOrganizationDialog', () => ({
  default: (props: { open: boolean; canOpenBilling: boolean; onDeleted: () => void; onOpenBilling: () => void }) =>
    props.open ? (
      <div data-testid="delete-dialog-stub" data-can-open-billing={String(props.canOpenBilling)}>
        <button data-testid="delete-dialog-stub-deleted" onClick={props.onDeleted} />
        <button data-testid="delete-dialog-stub-billing" onClick={props.onOpenBilling} />
      </div>
    ) : null,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: currentUser() }),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate, useBlocker: () => ({ status: 'idle' }) }));

const OWNER_ID = 'owner1';
const appTheme = extendTheme({ ...getThemeConfig() });

// The billing owner is deliberately not in users[] - the server never puts them there.
const org = {
  id: 'org1',
  name: 'Acme',
  userId: OWNER_ID,
  users: [{ userId: 'member1', permissions: ['update'] }],
} as unknown as IOrganizationDocument;

const renderAs = (user: Partial<IUserDocument> | null, organization: IOrganizationDocument = org) => {
  currentUser.mockReturnValue(user);
  const wrapper = (children: ReactNode) => <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>;
  return render(wrapper(<OrganizationSettingsSection organization={organization} />));
};

/**
 * The Danger Zone mirrors the server gate in organizationService/delete.ts (billing owner or
 * platform admin). The rest of this tab is open to anyone with org update, or a current manager, so these pin that
 * a member who can reach the tab is not shown a Delete button whose call would 403.
 */
describe('OrganizationSettingsSection - Danger Zone visibility', () => {
  it('exposes policy controls to read-only managers while keeping generic profile writes disabled', () => {
    updateOrg.mockClear();
    renderAs({ id: 'manager', isAdmin: false }, {
      ...org,
      adminUserIds: ['manager'],
      users: [{ userId: 'manager', permissions: ['read'] }],
    } as IOrganizationDocument);
    expect(screen.getByTestId('organization-sharing-save-btn')).not.toBeDisabled();
    expect(screen.getByTestId('organization-settings-system-prompt-input')).toBeDisabled();
    // A disabled prompt cannot be edited, so the save bar never appears for it.
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(updateOrg).not.toHaveBeenCalled();
  });

  it('shows Delete Team to the billing owner', () => {
    renderAs({ id: OWNER_ID, isAdmin: false });

    expect(screen.getByTestId('organization-settings-delete-btn')).toBeTruthy();
  });

  it('shows Delete Team to a platform admin', () => {
    renderAs({ id: 'platform1', isAdmin: true });

    expect(screen.getByTestId('organization-settings-delete-btn')).toBeTruthy();
  });

  it('hides Delete Team from a member who can otherwise manage the org', () => {
    renderAs({ id: 'member1', isAdmin: false });

    expect(screen.queryByTestId('organization-settings-delete-btn')).toBeNull();
    // The rest of the tab still renders for them.
    expect(screen.getByText('Team System Prompt')).toBeTruthy();
  });

  it('hides Delete Team when there is no resolved user', () => {
    renderAs(null);

    expect(screen.queryByTestId('organization-settings-delete-btn')).toBeNull();
  });
});

describe('OrganizationSettingsSection - Transfer ownership', () => {
  const managedOrg = {
    ...org,
    adminUserIds: ['admin1'],
    users: [
      { userId: 'admin1', permissions: ['read'] },
      { userId: 'member1', permissions: ['update'] },
    ],
  } as unknown as IOrganizationDocument;

  beforeEach(() => {
    transfer.mockReset().mockResolvedValue({ organizationId: 'org1', ownerId: 'admin1' });
    navigate.mockReset();
    members.loaded = true;
    members.list = [
      { id: OWNER_ID, name: 'Olivia Owner' },
      { id: 'admin1', name: 'Adam Admin', email: 'adam@example.com' },
      { id: 'member1', name: 'Mia Member' },
    ];
  });

  it('is hidden from a member', () => {
    renderAs({ id: 'member1', isAdmin: false }, managedOrg);
    expect(screen.queryByTestId('organization-settings-transfer-btn')).toBeNull();
  });

  it('is hidden for a personal organization', () => {
    renderAs({ id: OWNER_ID, isAdmin: false }, { ...managedOrg, personal: true } as IOrganizationDocument);
    expect(screen.queryByTestId('organization-settings-transfer-btn')).toBeNull();
  });

  it('is disabled with a hint when the org has no managers', () => {
    renderAs({ id: OWNER_ID, isAdmin: false }, org);
    expect((screen.getByTestId('organization-settings-transfer-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('organization-settings-transfer-hint')).toBeTruthy();
  });

  it('shows no hint while the members are still loading', () => {
    members.loaded = false;
    renderAs({ id: OWNER_ID, isAdmin: false }, managedOrg);
    expect(screen.queryByTestId('organization-settings-transfer-hint')).toBeNull();
  });

  it('does not offer a deactivated manager or one whose row confers no membership', () => {
    members.list = [
      { id: 'admin1', name: 'Adam Admin', isBanned: true },
      { id: 'member1', name: 'Mia Member' },
    ];
    renderAs({ id: OWNER_ID, isAdmin: false }, {
      ...managedOrg,
      adminUserIds: ['admin1', 'member1'],
      users: [
        { userId: 'admin1', permissions: ['read'] },
        { userId: 'member1', permissions: [] },
      ],
    } as unknown as IOrganizationDocument);
    expect((screen.getByTestId('organization-settings-transfer-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers only managers, shows the billing note, and transfers to the chosen one', async () => {
    renderAs({ id: OWNER_ID, isAdmin: false }, managedOrg);
    fireEvent.click(screen.getByTestId('organization-settings-transfer-btn'));

    expect(screen.getByTestId('transfer-ownership-billing-note').textContent).toContain('billing owner');
    const confirm = screen.getByTestId('transfer-ownership-confirm-btn') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('transfer-ownership-select'));
    const options = await screen.findAllByTestId('transfer-ownership-option');
    expect(options.map(option => option.textContent)).toEqual(['Adam Admin (adam@example.com)']);
    fireEvent.click(options[0]);

    expect(screen.getByTestId('transfer-ownership-billing-note').textContent).toContain('Adam Admin becomes');
    fireEvent.click(screen.getByTestId('transfer-ownership-confirm-btn'));

    await waitFor(() => expect(transfer).toHaveBeenCalledWith({ organizationId: 'org1', newOwnerId: 'admin1' }));
    // The transfer has committed, so the leave guard for an unsaved prompt must not intercept this.
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ search: { tab: 'members' }, ignoreBlocker: true })
      )
    );
  });

  it('keeps the dialog open when the transfer fails', async () => {
    transfer.mockRejectedValueOnce(new Error('refused'));
    renderAs({ id: OWNER_ID, isAdmin: false }, managedOrg);
    fireEvent.click(screen.getByTestId('organization-settings-transfer-btn'));
    fireEvent.click(screen.getByTestId('transfer-ownership-select'));
    fireEvent.click((await screen.findAllByTestId('transfer-ownership-option'))[0]);
    fireEvent.click(screen.getByTestId('transfer-ownership-confirm-btn'));

    await waitFor(() => expect(transfer).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('transfer-ownership-modal')).toBeTruthy();
  });
});

describe('OrganizationSettingsSection - system prompt save bar', () => {
  beforeEach(() => updateOrg.mockReset().mockResolvedValue({}));

  const promptInput = () => screen.getByTestId('organization-settings-system-prompt-input') as HTMLTextAreaElement;

  it('shows the save bar only once the prompt differs from the stored one, and saves it', () => {
    renderAs({ id: OWNER_ID });
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();

    fireEvent.change(promptInput(), { target: { value: 'Lunar elevators only.' } });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    expect(updateOrg).toHaveBeenCalledWith({ orgId: 'org1', data: { systemPrompt: 'Lunar elevators only.' } });
  });

  it('restores the stored prompt on Discard', () => {
    renderAs({ id: OWNER_ID });
    fireEvent.change(promptInput(), { target: { value: 'Draft' } });

    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));

    expect(promptInput().value).toBe('');
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(updateOrg).not.toHaveBeenCalled();
  });
});

describe('OrganizationSettingsSection - delete', () => {
  it('leaves past the unsaved-prompt guard once the team is deleted', async () => {
    navigate.mockReset();
    renderAs({ id: OWNER_ID, isAdmin: false });
    fireEvent.change(screen.getByTestId('organization-settings-system-prompt-input'), {
      target: { value: 'An edit that was never saved.' },
    });
    expect(screen.getByTestId('admin-save-bar')).toBeTruthy();

    fireEvent.click(screen.getByTestId('organization-settings-delete-btn'));
    fireEvent.click(screen.getByTestId('delete-dialog-stub-deleted'));
    expect(navigate).toHaveBeenCalledWith({ to: '/organizations', replace: true, ignoreBlocker: true });
    expect(screen.queryByTestId('delete-dialog-stub')).toBeNull();
  });
});

describe('OrganizationSettingsSection - Delete flow', () => {
  beforeEach(() => navigate.mockClear());

  it('opens the delete dialog instead of a generic confirmation', () => {
    renderAs({ id: OWNER_ID, isAdmin: false });
    expect(screen.queryByTestId('delete-dialog-stub')).toBeNull();
    fireEvent.click(screen.getByTestId('organization-settings-delete-btn'));
    expect(screen.getByTestId('delete-dialog-stub').getAttribute('data-can-open-billing')).toBe('true');
  });

  it('does not offer Billing to a platform admin, whom the Billing tab refuses', () => {
    renderAs({ id: 'admin9', isAdmin: true });
    fireEvent.click(screen.getByTestId('organization-settings-delete-btn'));
    expect(screen.getByTestId('delete-dialog-stub').getAttribute('data-can-open-billing')).toBe('false');
  });

  it('replaces the deleted team page with the teams list', () => {
    renderAs({ id: OWNER_ID, isAdmin: false });
    fireEvent.click(screen.getByTestId('organization-settings-delete-btn'));
    fireEvent.click(screen.getByTestId('delete-dialog-stub-deleted'));
    expect(navigate).toHaveBeenCalledWith({ to: '/organizations', replace: true, ignoreBlocker: true });
    expect(screen.queryByTestId('delete-dialog-stub')).toBeNull();
  });

  it('closes the dialog and opens the Billing tab when asked', () => {
    renderAs({ id: OWNER_ID, isAdmin: false });
    fireEvent.click(screen.getByTestId('organization-settings-delete-btn'));
    fireEvent.click(screen.getByTestId('delete-dialog-stub-billing'));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { tab: 'billing' } }));
    expect(screen.queryByTestId('delete-dialog-stub')).toBeNull();
  });
});
