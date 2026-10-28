import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { UserProfileView } from './UserProfileView';
import { USER_PROFILE_TABS, type UserProfileTab } from './userProfileSearch';
import { ProfileTestWrapper, buildProfile } from './profileTestUtils';
import type { AdminUserProfile } from './userProfileModel';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  setComplianceUserId: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/hooks/useHelpPanel', () => ({ openHelpPanel: vi.fn() }));
vi.mock('../BulkAbuseResponseModal', () => ({
  default: ({
    selectedUserIds,
    recordAction,
    onExecuted,
  }: {
    selectedUserIds: string[];
    recordAction: string;
    onExecuted: () => void;
  }) => (
    <div role="dialog" data-testid="bulk-abuse-modal" data-user={selectedUserIds[0]} data-action={recordAction}>
      <button data-testid="stub-bulk-executed-btn" onClick={onExecuted} />
    </div>
  ),
}));
vi.mock('./actions/useAdminUserUpdate', () => ({ useAdminUserUpdate: () => mocks.update }));
vi.mock('../ComplianceModal', () => ({
  useComplianceModal: (select: (state: { setUserId: (id: string) => void }) => unknown) =>
    select({ setUserId: mocks.setComplianceUserId }),
}));
vi.mock('../Details/GrantSubscriptionModal', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="grant-subscription-modal">
      <button data-testid="grant-subscription-close" onClick={onClose} />
    </div>
  ),
}));
vi.mock('./tabs/ActivityTab', () => ({
  ActivityTab: ({ userId, onOpenCredits }: { userId: string; onOpenCredits: () => void }) => (
    <div data-testid="stub-activity" data-user-id={userId}>
      <button data-testid="stub-activity-credits-btn" onClick={onOpenCredits} />
    </div>
  ),
}));
vi.mock('./tabs/SignInsTab', () => ({ SignInsTab: () => <div data-testid="stub-signins" /> }));
vi.mock('./tabs/AdminLogTab', () => ({ AdminLogTab: () => <div data-testid="stub-admin-log" /> }));
vi.mock('./UserProfileStats', () => ({ UserProfileStats: () => <div data-testid="stub-stats" /> }));
vi.mock('./tabs/OverviewTab', () => ({
  OverviewTab: ({ onAction, onViewActivity }: { onAction: (action: 'tags') => void; onViewActivity: () => void }) => (
    <div data-testid="stub-overview">
      <button data-testid="stub-overview-tags-btn" onClick={() => onAction('tags')} />
      <button data-testid="stub-overview-activity-btn" onClick={onViewActivity} />
    </div>
  ),
}));
vi.mock('./tabs/credits/CreditsTab', () => ({
  CreditsTab: ({ onAdjust }: { onAdjust: () => void }) => (
    <div data-testid="stub-credits">
      <button data-testid="stub-credits-adjust-btn" onClick={onAdjust} />
    </div>
  ),
}));
vi.mock('./tabs/keys/ApiKeysTab', () => ({ ApiKeysTab: () => <div data-testid="stub-keys" /> }));
vi.mock('./actions/accessDialogs', () => {
  const stub = (id: string) => {
    const Stub = () => <div data-testid={id} />;
    return Stub;
  };
  return {
    ChangeRoleDialog: stub('change-role-dialog'),
    ManageTagsDialog: stub('manage-tags-dialog'),
    ProductAccessDialog: stub('product-access-dialog'),
  };
});
vi.mock('./actions/accountDialogs', () => {
  const stub = (id: string) => {
    const Stub = () => <div data-testid={id} />;
    return Stub;
  };
  return {
    ApiKeyTrustDialog: stub('api-key-trust-dialog'),
    EmailVerificationDialog: stub('email-verification-dialog'),
    LoginAsDialog: stub('login-as-dialog'),
    ResetMfaDialog: stub('mfa-reset-dialog'),
    RestrictDialog: stub('restrict-dialog'),
    SendMessageDialog: stub('send-message-dialog'),
    DeleteUserDialog: ({ onDeleted }: { onDeleted: () => void }) => (
      <div data-testid="delete-user-dialog">
        <button data-testid="stub-delete-done-btn" onClick={onDeleted} />
      </div>
    ),
  };
});

const setup = (user: AdminUserProfile = buildProfile(), tab: UserProfileTab = 'overview') => {
  const onTabChange = vi.fn();
  const onBack = vi.fn();
  const view = render(<UserProfileView user={user} tab={tab} onTabChange={onTabChange} onBack={onBack} />, {
    wrapper: ProfileTestWrapper,
  });
  return { onTabChange, onBack, ...view };
};

const press = (key: string) => fireEvent.keyDown(document.body, { key });

describe('UserProfileView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue(undefined);
  });

  describe('shortcuts', () => {
    it('c opens Adjust credits', () => {
      setup();

      press('c');

      expect(screen.getByTestId('adjust-credits-dialog')).toBeInTheDocument();
    });

    it('s opens Suspend', () => {
      setup();

      press('s');

      expect(screen.getByTestId('suspend-dialog')).toBeInTheDocument();
    });

    it('s does nothing for a suspended account', () => {
      setup(buildProfile({ isBanned: true }));

      press('s');

      expect(screen.queryByTestId('suspend-dialog')).not.toBeInTheDocument();
    });

    it('ignores shortcuts while a dialog is already open', () => {
      setup();
      press('c');

      press('s');

      expect(screen.queryByTestId('suspend-dialog')).not.toBeInTheDocument();
    });

    it('lists the profile commands in the palette, with Suspend disabled for a suspended account', () => {
      setup(buildProfile({ isBanned: true }));

      fireEvent.click(screen.getByTestId('admin-command-open-btn'));

      expect(screen.getByRole('option', { name: 'Adjust credits' })).toBeEnabled();
      expect(screen.getByRole('option', { name: 'Suspend account' })).toBeDisabled();
    });

    it('does not repeat the header actions in the command strip', () => {
      setup();

      expect(screen.queryByTestId('admin-command-credits-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('admin-command-suspend-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('admin-command-revoke-btn')).toBeInTheDocument();
    });

    it('Revoke API keys opens the audited revoke flow for this user only', () => {
      setup();

      fireEvent.click(screen.getByTestId('admin-command-revoke-btn'));

      const modal = screen.getByTestId('bulk-abuse-modal');
      expect(modal).toHaveAttribute('data-user', buildProfile().id);
      expect(modal).toHaveAttribute('data-action', 'revoke');
    });

    it('refetches the API keys once the revoke has run', () => {
      const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
      setup();

      fireEvent.click(screen.getByTestId('admin-command-revoke-btn'));
      fireEvent.click(screen.getByTestId('stub-bulk-executed-btn'));

      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'user-api-keys', buildProfile().id] });
      invalidate.mockRestore();
    });

    it('closes the dialog from its cancel button', async () => {
      setup();
      press('c');

      fireEvent.click(screen.getByTestId('adjust-credits-dialog-cancel-btn'));

      await waitFor(() => expect(screen.queryByTestId('adjust-credits-dialog')).not.toBeInTheDocument());
    });
  });

  describe('header and menu', () => {
    it('the Adjust credits button opens its dialog', () => {
      setup();

      fireEvent.click(screen.getByTestId('user-profile-adjust-credits-btn'));

      expect(screen.getByTestId('adjust-credits-dialog')).toBeInTheDocument();
    });

    it('the Suspend button opens its dialog, and is gone for a suspended account', () => {
      const { unmount } = setup();
      fireEvent.click(screen.getByTestId('user-profile-suspend-btn'));
      expect(screen.getByTestId('suspend-dialog')).toBeInTheDocument();
      unmount();

      setup(buildProfile({ isBanned: true }));
      expect(screen.queryByTestId('user-profile-suspend-btn')).not.toBeInTheDocument();
    });

    it.each([
      ['loginAs', 'login-as-dialog'],
      ['message', 'send-message-dialog'],
      ['role', 'change-role-dialog'],
      ['productAccess', 'product-access-dialog'],
      ['restrict', 'restrict-dialog'],
      ['delete', 'delete-user-dialog'],
      ['subscription', 'grant-subscription-modal'],
    ])('the More menu item %s opens %s', async (action, dialogId) => {
      setup();

      fireEvent.click(screen.getByTestId('user-profile-more-btn'));
      fireEvent.click(await screen.findByTestId(`user-profile-menu-${action}-item`));

      expect(await screen.findByTestId(dialogId)).toBeInTheDocument();
    });

    it('the Compliance record item opens the compliance modal for this user', async () => {
      const user = buildProfile();
      setup(user);

      fireEvent.click(screen.getByTestId('user-profile-more-btn'));
      fireEvent.click(await screen.findByTestId('user-profile-menu-compliance-item'));

      expect(mocks.setComplianceUserId).toHaveBeenCalledWith(user.id);
    });

    it('opens a dialog requested by the overview tab', () => {
      setup();

      fireEvent.click(screen.getByTestId('stub-overview-tags-btn'));

      expect(screen.getByTestId('manage-tags-dialog')).toBeInTheDocument();
    });

    it('goes back to the list once a deleted user is reported', async () => {
      const { onBack } = setup();
      fireEvent.click(screen.getByTestId('user-profile-more-btn'));
      fireEvent.click(await screen.findByTestId('user-profile-menu-delete-item'));

      fireEvent.click(await screen.findByTestId('stub-delete-done-btn'));

      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('the breadcrumb goes back', () => {
      const { onBack } = setup();

      fireEvent.click(screen.getByTestId('user-profile-back-btn'));

      expect(onBack).toHaveBeenCalledTimes(1);
    });
  });

  describe('tabs', () => {
    it('reports the clicked tab through onTabChange', () => {
      const { onTabChange } = setup();

      fireEvent.click(screen.getByTestId('user-profile-tab-credits'));

      expect(onTabChange).toHaveBeenCalledWith('credits');
    });

    it('shows a tab for every route slug and marks the current one selected', () => {
      setup(buildProfile(), 'keys');

      for (const tab of USER_PROFILE_TABS) {
        expect(screen.getByTestId(`user-profile-tab-${tab}`)).toBeInTheDocument();
      }
      expect(screen.getByTestId('user-profile-tab-keys')).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('user-profile-tab-overview')).toHaveAttribute('aria-selected', 'false');
    });

    it('renders the panel for the tab prop, not for clicks', () => {
      const { rerender, onTabChange } = setup(buildProfile(), 'overview');
      expect(screen.getByTestId('user-profile-panel-overview')).toBeInTheDocument();
      expect(screen.getByTestId('stub-overview')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('user-profile-tab-credits'));
      expect(onTabChange).toHaveBeenCalledWith('credits');
      expect(screen.getByTestId('user-profile-panel-overview')).toBeInTheDocument();

      const user = buildProfile();
      rerender(<UserProfileView user={user} tab="credits" onTabChange={onTabChange} onBack={vi.fn()} />);
      expect(screen.getByTestId('user-profile-panel-credits')).toBeInTheDocument();
      expect(screen.queryByTestId('user-profile-panel-overview')).not.toBeInTheDocument();
      expect(screen.getByTestId('stub-credits')).toBeInTheDocument();
    });

    it.each([
      ['activity', 'stub-activity'],
      ['keys', 'stub-keys'],
      ['signins', 'stub-signins'],
      ['admin', 'stub-admin-log'],
    ] as const)('renders the %s panel', (tab, stubId) => {
      setup(buildProfile(), tab);

      expect(screen.getByTestId(`user-profile-panel-${tab}`)).toContainElement(screen.getByTestId(stubId));
    });

    it('passes the user id to the activity panel', () => {
      const user = buildProfile();
      setup(user, 'activity');

      expect(screen.getByTestId('stub-activity')).toHaveAttribute('data-user-id', user.id);
    });

    it('lets the overview jump to the activity tab', () => {
      const { onTabChange } = setup();

      fireEvent.click(screen.getByTestId('stub-overview-activity-btn'));

      expect(onTabChange).toHaveBeenCalledWith('activity');
    });

    it('lets a credit event on the activity tab open the credits tab', () => {
      const { onTabChange } = setup(buildProfile(), 'activity');

      fireEvent.click(screen.getByTestId('stub-activity-credits-btn'));

      expect(onTabChange).toHaveBeenCalledWith('credits');
    });

    it('opens Adjust credits from the credits tab', () => {
      setup(buildProfile(), 'credits');

      fireEvent.click(screen.getByTestId('stub-credits-adjust-btn'));

      expect(screen.getByTestId('adjust-credits-dialog')).toBeInTheDocument();
    });
  });

  describe('status banner', () => {
    it('is absent for an active account', () => {
      setup();

      expect(screen.queryByTestId('user-profile-status-banner')).not.toBeInTheDocument();
    });

    it('Reinstate on a suspended account writes isBanned: false and offers an undo', async () => {
      setup(buildProfile({ isBanned: true }));

      expect(screen.getByTestId('user-profile-status-banner')).toHaveTextContent('Suspended.');
      fireEvent.click(screen.getByTestId('user-profile-reinstate-btn'));

      await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ isBanned: false }));
      expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('Account reinstated');
      fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
      await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith({ isBanned: true }));
    });

    it('shows no toast when the reinstatement fails', async () => {
      mocks.update.mockRejectedValue(new Error('nope'));
      setup(buildProfile({ isBanned: true }));

      fireEvent.click(screen.getByTestId('user-profile-reinstate-btn'));

      await waitFor(() => expect(mocks.update).toHaveBeenCalled());
      expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
    });

    it('a restricted account offers Lift restriction, which opens the restrict dialog', () => {
      setup(buildProfile({ isModerated: true }));

      expect(screen.getByTestId('user-profile-status-banner')).toHaveTextContent('Restricted.');
      fireEvent.click(screen.getByTestId('user-profile-reinstate-btn'));

      expect(mocks.update).not.toHaveBeenCalled();
      expect(screen.getByTestId('restrict-dialog')).toBeInTheDocument();
    });
  });
});
