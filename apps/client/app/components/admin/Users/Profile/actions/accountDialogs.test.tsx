import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  ApiKeyTrustDialog,
  CancelDeletionDialog,
  DeleteUserDialog,
  EmailVerificationDialog,
  InternalAccountDialog,
  LoginAsDialog,
  ResetMfaDialog,
  RestrictDialog,
  ScheduleDeletionDialog,
  SendMessageDialog,
  ShadowTierDialog,
} from './accountDialogs';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';
import type { AdminUserProfile } from '../userProfileModel';

const USER_ID = 'test-user-1';

type CurrentUser = { id: string; mfa?: { totpEnabled: boolean } } | null;

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  apiPost: vi.fn(),
  navigate: vi.fn(),
  deleteUser: vi.fn(),
  loginAs: vi.fn(),
  resetMfa: vi.fn(),
  sendMessage: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastInfo: vi.fn(),
  currentUser: null as CurrentUser,
}));

vi.mock('./useAdminUserUpdate', () => ({
  useAdminUserUpdate: () => mocks.update,
  adminUpdateErrorMessage: (_error: unknown, fallback: string) => fallback,
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mocks.apiPost } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@client/app/hooks/data/user', () => ({
  useDeleteUser: () => ({ mutateAsync: mocks.deleteUser }),
  useLoginAsUser: () => ({ mutateAsync: mocks.loginAs }),
}));
vi.mock('@client/app/hooks/data/mfa', () => ({ useForceResetMFA: () => ({ mutateAsync: mocks.resetMfa }) }));
vi.mock('@client/app/hooks/data/inbox', () => ({ useSendSystemMessage: () => ({ mutateAsync: mocks.sendMessage }) }));
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess, warning: mocks.toastWarning, info: mocks.toastInfo },
}));

const renderDialog = (
  ui: (user: AdminUserProfile, onClose: () => void) => React.ReactElement,
  user = buildProfile()
) => {
  const onClose = vi.fn();
  render(ui(user, onClose), { wrapper: ProfileTestWrapper });
  return { onClose };
};

const pickReason = (dialogId: string) => fireEvent.click(screen.getByTestId(`${dialogId}-reason-input-preset-0`));
const confirmButton = (dialogId: string) => screen.getByTestId(`${dialogId}-confirm-btn`);
const hint = (dialogId: string) => screen.getByTestId(`${dialogId}-hint`);

describe('account dialogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = { id: 'admin-1', mfa: { totpEnabled: true } };
    mocks.update.mockResolvedValue(undefined);
    mocks.apiPost.mockResolvedValue({ data: {} });
    mocks.deleteUser.mockResolvedValue(undefined);
    mocks.loginAs.mockResolvedValue(undefined);
    mocks.resetMfa.mockResolvedValue(undefined);
    mocks.sendMessage.mockResolvedValue(undefined);
  });

  describe('RestrictDialog', () => {
    it('restricts an active account, previewing Active to Restricted, and needs a reason', async () => {
      const { onClose } = renderDialog((user, close) => <RestrictDialog user={user} onClose={close} />);

      expect(screen.getByTestId('restrict-dialog-preview-before')).toHaveTextContent('Active');
      expect(screen.getByTestId('restrict-dialog-preview-after')).toHaveTextContent('Restricted');
      expect(confirmButton('restrict-dialog')).toBeDisabled();
      expect(hint('restrict-dialog')).toHaveTextContent('Pick a reason');

      pickReason('restrict-dialog');
      fireEvent.click(confirmButton('restrict-dialog'));

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({
          isModerated: true,
          statusChangeReason: 'Abuse / automated signups',
        })
      );
      expect(onClose).toHaveBeenCalled();
      expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('Account restricted');
      fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
      await waitFor(() =>
        expect(mocks.update).toHaveBeenLastCalledWith({
          isModerated: false,
          statusChangeReason: 'Undo: Abuse / automated signups',
        })
      );
    });

    it('lifts an existing restriction', async () => {
      renderDialog(
        (user, close) => <RestrictDialog user={user} onClose={close} />,
        buildProfile({ isModerated: true })
      );

      expect(screen.getByTestId('restrict-dialog-preview-before')).toHaveTextContent('Restricted');
      expect(screen.getByTestId('restrict-dialog-preview-after')).toHaveTextContent('Active');
      expect(confirmButton('restrict-dialog')).toHaveTextContent('Lift restriction');
      pickReason('restrict-dialog');
      fireEvent.click(confirmButton('restrict-dialog'));

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({
          isModerated: false,
          statusChangeReason: 'Suspended in error',
        })
      );
    });

    it('stays open when the write fails', async () => {
      mocks.update.mockRejectedValue(new Error('nope'));
      const { onClose } = renderDialog((user, close) => <RestrictDialog user={user} onClose={close} />);
      pickReason('restrict-dialog');

      fireEvent.click(confirmButton('restrict-dialog'));

      await waitFor(() => expect(mocks.update).toHaveBeenCalled());
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('ShadowTierDialog', () => {
    const shadowed = buildProfile({
      throttle: {
        tier: 'shadow',
        source: 'signup_honeypot',
        reason: 'auto',
        changedAt: new Date('2026-10-01T00:00:00Z'),
      },
      riskSignals: [{ type: 'signup_honeypot', at: new Date('2026-10-01T00:00:00Z') }],
    });
    const id = 'profile-shadow-tier-dialog';

    it('shows No signals and moves to the limited tier with a reason', async () => {
      const { onClose } = renderDialog((user, close) => <ShadowTierDialog user={user} onClose={close} />);

      expect(screen.getByTestId('profile-shadow-tier-current')).toHaveTextContent('Tier standard. Never changed.');
      expect(screen.getByTestId('profile-shadow-tier-signals')).toHaveTextContent('No signals');
      expect(confirmButton(id)).toBeDisabled();
      pickReason(id);
      fireEvent.click(confirmButton(id));

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({
          throttleTier: 'shadow',
          throttleReason: 'Abuse / automated signups',
        })
      );
      expect(onClose).toHaveBeenCalled();
      expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('Moved to limited tier');
      fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
      await waitFor(() =>
        expect(mocks.update).toHaveBeenLastCalledWith({
          throttleTier: 'none',
          throttleReason: 'Undo: Abuse / automated signups',
        })
      );
    });

    it('flags the tier as not in effect for a Developer-tagged user only', () => {
      renderDialog(
        (user, close) => <ShadowTierDialog user={user} onClose={close} />,
        buildProfile({ tags: ['Developer'] })
      );
      expect(screen.getByTestId('profile-shadow-tier-exempt')).toHaveTextContent('Not in effect');
    });

    it('flags the tier as not in effect for an admin', () => {
      renderDialog((user, close) => <ShadowTierDialog user={user} onClose={close} />, buildProfile({ isAdmin: true }));
      expect(screen.getByTestId('profile-shadow-tier-exempt')).toBeInTheDocument();
    });

    it('does not flag a normal user', () => {
      renderDialog((user, close) => <ShadowTierDialog user={user} onClose={close} />);
      expect(screen.queryByTestId('profile-shadow-tier-exempt')).not.toBeInTheDocument();
    });

    it('shows state and signals, and removes the tier', async () => {
      renderDialog((user, close) => <ShadowTierDialog user={user} onClose={close} />, shadowed);

      expect(screen.getByTestId('profile-shadow-tier-current')).toHaveTextContent(
        'Tier limited, source signup_honeypot, changed 2026-10-01.'
      );
      expect(screen.getByTestId('profile-shadow-tier-signals')).toHaveTextContent('signup_honeypot (2026-10-01)');
      expect(confirmButton(id)).toHaveTextContent('Remove limited tier');
      pickReason(id);
      fireEvent.click(confirmButton(id));

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith({ throttleTier: 'none', throttleReason: 'Reviewed, not abusive' })
      );
      expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('Limited tier removed');
      fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
      await waitFor(() =>
        expect(mocks.update).toHaveBeenLastCalledWith({
          throttleTier: 'shadow',
          throttleReason: 'Undo: Reviewed, not abusive',
        })
      );
    });

    it('stays open and shows no undo toast when the update fails', async () => {
      mocks.update.mockRejectedValueOnce(new Error('boom'));
      const { onClose } = renderDialog((user, close) => <ShadowTierDialog user={user} onClose={close} />);

      pickReason(id);
      fireEvent.click(confirmButton(id));

      await waitFor(() => expect(mocks.update).toHaveBeenCalled());
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByTestId('undo-toast-message')).not.toBeInTheDocument();
    });

    it('renders a dash for a missing changed date', () => {
      const throttle = { tier: 'none', source: 'admin', reason: 'ok' } as unknown as AdminUserProfile['throttle'];
      renderDialog((user, close) => <ShadowTierDialog user={user} onClose={close} />, buildProfile({ throttle }));

      expect(screen.getByTestId('profile-shadow-tier-current')).toHaveTextContent(
        'Tier standard, source admin, changed -.'
      );
      expect(confirmButton(id)).toHaveTextContent('Move to limited tier');
    });
  });

  describe('EmailVerificationDialog', () => {
    it('marks an unverified email verified through the verify-email endpoint', async () => {
      renderDialog(
        (user, close) => <EmailVerificationDialog user={user} onClose={close} />,
        buildProfile({ emailVerified: false })
      );

      expect(screen.getByTestId('email-verification-dialog-preview-before')).toHaveTextContent('Unverified');
      expect(screen.getByTestId('email-verification-dialog-preview-after')).toHaveTextContent('Verified');
      expect(confirmButton('email-verification-dialog')).toBeDisabled();
      pickReason('email-verification-dialog');
      fireEvent.click(confirmButton('email-verification-dialog'));

      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(`/api/admin/users/${USER_ID}/verify-email`, {
          reason: 'Ownership confirmed by support',
        })
      );
      fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenLastCalledWith(`/api/admin/users/${USER_ID}/unverify-email`, {
          reason: 'Undo: Ownership confirmed by support',
        })
      );
    });

    it('marks a verified email unverified through the unverify-email endpoint', async () => {
      renderDialog((user, close) => <EmailVerificationDialog user={user} onClose={close} />);

      expect(screen.getByTestId('email-verification-dialog-preview-before')).toHaveTextContent('Verified');
      expect(screen.getByTestId('email-verification-dialog-preview-after')).toHaveTextContent('Unverified');
      pickReason('email-verification-dialog');
      fireEvent.click(confirmButton('email-verification-dialog'));

      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(`/api/admin/users/${USER_ID}/unverify-email`, {
          reason: 'Ownership confirmed by support',
        })
      );
    });

    it('toasts the failure and stays open when the endpoint rejects', async () => {
      mocks.apiPost.mockRejectedValue(new Error('boom'));
      const { onClose } = renderDialog((user, close) => <EmailVerificationDialog user={user} onClose={close} />);
      pickReason('email-verification-dialog');

      fireEvent.click(confirmButton('email-verification-dialog'));

      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('The email status was not changed.'));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('ApiKeyTrustDialog', () => {
    it('trusts an untrusted account with approved: true', async () => {
      renderDialog((user, close) => <ApiKeyTrustDialog user={user} onClose={close} />);

      expect(screen.getByTestId('api-key-trust-dialog-preview-before')).toHaveTextContent('Not trusted');
      expect(screen.getByTestId('api-key-trust-dialog-preview-after')).toHaveTextContent('Trusted');
      expect(confirmButton('api-key-trust-dialog')).toBeDisabled();
      pickReason('api-key-trust-dialog');
      fireEvent.click(confirmButton('api-key-trust-dialog'));

      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(`/api/admin/users/${USER_ID}/api-key-trust`, {
          approved: true,
          reason: 'Known integration',
        })
      );
      fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenLastCalledWith(`/api/admin/users/${USER_ID}/api-key-trust`, {
          approved: false,
          reason: 'Undo: Known integration',
        })
      );
    });

    it('removes trust from a trusted account with approved: false', async () => {
      renderDialog(
        (user, close) => <ApiKeyTrustDialog user={user} onClose={close} />,
        buildProfile({ apiKeyTrustApproved: true })
      );

      expect(screen.getByTestId('api-key-trust-dialog-preview-before')).toHaveTextContent('Trusted');
      pickReason('api-key-trust-dialog');
      fireEvent.click(confirmButton('api-key-trust-dialog'));

      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(`/api/admin/users/${USER_ID}/api-key-trust`, {
          approved: false,
          reason: 'Known integration',
        })
      );
    });
  });

  describe('ScheduleDeletionDialog', () => {
    const id = 'schedule-deletion-dialog';
    const typeEmail = () =>
      fireEvent.change(screen.getByTestId(`${id}-typed-input`), { target: { value: 'ada@example.com' } });
    const pickDate = (value: string) =>
      fireEvent.change(screen.getByTestId(`${id}-received-input`), { target: { value } });

    it('blocks confirm until a date, a reason and the typed email are present', () => {
      renderDialog((user, close) => <ScheduleDeletionDialog user={user} onClose={close} />);

      expect(confirmButton(id)).toBeDisabled();
      pickReason(id);
      typeEmail();
      expect(confirmButton(id)).toBeDisabled();
      expect(hint(id)).toHaveTextContent('Enter the date the request email arrived.');
      pickDate('2026-11-01');
      expect(confirmButton(id)).toBeEnabled();
    });

    it('limits the date to today and blocks a future one', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 10, 6, 12, 0));
      try {
        renderDialog((user, close) => <ScheduleDeletionDialog user={user} onClose={close} />);

        expect(screen.getByTestId(`${id}-received-input`)).toHaveAttribute('max', '2026-11-06');
        pickReason(id);
        typeEmail();
        pickDate('2999-01-01');
        expect(confirmButton(id)).toBeDisabled();
        expect(hint(id)).toHaveTextContent('cannot be in the future');
      } finally {
        vi.useRealTimers();
      }
    });

    // TZ is pinned east and west of UTC: in UTC (the CI default) a toISOString() day equals the local day.
    it.each([
      ['Asia/Singapore', 'just after local midnight', [0, 30]],
      ['America/Los_Angeles', 'just before local midnight', [23, 30]],
    ] as const)('uses the admin local day as today in %s, %s', (zone, _name, [hour, minute]) => {
      const originalTz = process.env.TZ;
      process.env.TZ = zone;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 10, 6, hour, minute));
      try {
        renderDialog((user, close) => <ScheduleDeletionDialog user={user} onClose={close} />);
        expect(screen.getByTestId(`${id}-received-input`)).toHaveAttribute('max', '2026-11-06');
        pickReason(id);
        typeEmail();
        pickDate('2026-11-06');
        expect(confirmButton(id)).toBeEnabled();
        pickDate('2026-11-07');
        expect(confirmButton(id)).toBeDisabled();
      } finally {
        vi.useRealTimers();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
      }
    });

    it('shows the current account status as the preview start', () => {
      renderDialog((user, close) => <ScheduleDeletionDialog user={{ ...user, isBanned: true }} onClose={close} />);
      expect(screen.getByTestId(`${id}-preview`)).toHaveTextContent('Suspended');
    });

    it('warns, without blocking, when the purge lands over 30 days after receipt', () => {
      renderDialog((user, close) => <ScheduleDeletionDialog user={user} onClose={close} />);

      pickDate('2020-01-01');
      expect(screen.getByTestId(`${id}-late-warning`)).toBeInTheDocument();
      pickReason(id);
      typeEmail();
      expect(confirmButton(id)).toBeEnabled();
    });

    it('posts schedule-deletion with the received date and the verification note, then closes', async () => {
      const { onClose } = renderDialog((user, close) => <ScheduleDeletionDialog user={user} onClose={close} />);
      pickDate('2026-11-01');
      pickReason(id);
      typeEmail();

      fireEvent.click(confirmButton(id));

      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(`/api/admin/users/${USER_ID}/schedule-deletion`, {
          receivedAt: '2026-11-01',
          reason: 'Request sent from the email on file',
        })
      );
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('shows pending approval without claiming the deletion was scheduled', async () => {
      mocks.apiPost.mockResolvedValue({ data: { approvalId: 'approval-1', status: 'pending' } });
      const { onClose } = renderDialog((user, close) => <ScheduleDeletionDialog user={user} onClose={close} />);
      pickDate('2026-11-01');
      pickReason(id);
      typeEmail();
      fireEvent.click(confirmButton(id));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(mocks.toastInfo).toHaveBeenCalledWith(expect.stringContaining('Submitted for approval'));
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });

    it('stays open and toasts when the server refuses', async () => {
      mocks.apiPost.mockRejectedValue(new Error('nope'));
      const { onClose } = renderDialog((user, close) => <ScheduleDeletionDialog user={user} onClose={close} />);
      pickDate('2026-11-01');
      pickReason(id);
      typeEmail();

      fireEvent.click(confirmButton(id));

      await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('CancelDeletionDialog', () => {
    const id = 'cancel-deletion-dialog';
    const pending = buildProfile({
      deletion: {
        requestedAt: new Date('2026-10-01T00:00:00Z'),
        scheduledFor: new Date('2026-11-20T00:00:00Z'),
        source: 'support',
      },
    });

    it('requires a reason, then posts cancel-deletion with it', async () => {
      const { onClose } = renderDialog((user, close) => <CancelDeletionDialog user={user} onClose={close} />, pending);

      expect(screen.getByTestId(`${id}-preview-before`)).toHaveTextContent('Deletion on Nov 20, 2026 (UTC)');
      expect(screen.getByTestId(`${id}-preview-after`)).toHaveTextContent('Active');
      expect(confirmButton(id)).toBeDisabled();
      pickReason(id);
      fireEvent.click(confirmButton(id));

      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(`/api/admin/users/${USER_ID}/cancel-deletion`, {
          reason: 'User asked to cancel, identity verified',
        })
      );
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });
  });

  describe('InternalAccountDialog', () => {
    it('marks a customer account internal with isInternal: true, and undoes it', async () => {
      renderDialog((user, close) => <InternalAccountDialog user={user} onClose={close} />);

      expect(screen.getByTestId('internal-account-dialog-preview-before')).toHaveTextContent('Customer');
      expect(screen.getByTestId('internal-account-dialog-preview-after')).toHaveTextContent('Internal');
      expect(confirmButton('internal-account-dialog')).toBeDisabled();
      pickReason('internal-account-dialog');
      fireEvent.click(confirmButton('internal-account-dialog'));

      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(`/api/admin/users/${USER_ID}/internal`, {
          isInternal: true,
          reason: 'Team member',
        })
      );
      fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenLastCalledWith(`/api/admin/users/${USER_ID}/internal`, {
          isInternal: false,
          reason: 'Undo: Team member',
        })
      );
    });

    it('stops marking an internal account with isInternal: false', async () => {
      renderDialog(
        (user, close) => <InternalAccountDialog user={user} onClose={close} />,
        buildProfile({ isInternal: true })
      );

      expect(screen.getByTestId('internal-account-dialog-preview-before')).toHaveTextContent('Internal');
      expect(screen.getByTestId('internal-account-dialog-preview-after')).toHaveTextContent('Customer');
      pickReason('internal-account-dialog');
      fireEvent.click(confirmButton('internal-account-dialog'));

      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(`/api/admin/users/${USER_ID}/internal`, {
          isInternal: false,
          reason: 'Team member',
        })
      );
    });
    it('previews an admin as internal either way, since analytics counts an admin as internal', () => {
      renderDialog(
        (user, close) => <InternalAccountDialog user={user} onClose={close} />,
        buildProfile({ isInternal: true, isAdmin: true })
      );

      expect(screen.getByTestId('internal-account-dialog-preview-before')).toHaveTextContent('Internal');
      expect(screen.getByTestId('internal-account-dialog-preview-after')).toHaveTextContent('Internal (admin)');
    });
  });

  describe('ResetMfaDialog', () => {
    it('previews the authenticator going away and sends the reason with the user id', async () => {
      const { onClose } = renderDialog((user, close) => <ResetMfaDialog user={user} onClose={close} />);

      expect(screen.getByTestId('mfa-reset-dialog-preview-before')).toHaveTextContent('Authenticator app');
      expect(screen.getByTestId('mfa-reset-dialog-preview-after')).toHaveTextContent('Not set up');
      expect(confirmButton('mfa-reset-dialog')).toBeDisabled();
      pickReason('mfa-reset-dialog');
      fireEvent.click(confirmButton('mfa-reset-dialog'));

      await waitFor(() =>
        expect(mocks.resetMfa).toHaveBeenCalledWith({
          userId: USER_ID,
          reason: 'Lost authenticator, identity verified',
        })
      );
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(mocks.toastSuccess).toHaveBeenCalled();
      expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
    });

    it('toasts the failure and stays open when the reset is rejected', async () => {
      mocks.resetMfa.mockRejectedValue(new Error('boom'));
      const { onClose } = renderDialog((user, close) => <ResetMfaDialog user={user} onClose={close} />);
      pickReason('mfa-reset-dialog');

      fireEvent.click(confirmButton('mfa-reset-dialog'));

      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Two-factor was not reset.'));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('DeleteUserDialog', () => {
    const renderDelete = (user = buildProfile()) => {
      const onDeleted = vi.fn();
      const { onClose } = renderDialog(
        (target, close) => <DeleteUserDialog user={target} onClose={close} onDeleted={onDeleted} />,
        user
      );
      return { onClose, onDeleted };
    };

    it('needs the reason and the email typed exactly before it unlocks', async () => {
      const { onClose, onDeleted } = renderDelete();

      expect(screen.getByTestId('delete-user-dialog-typed-expected')).toHaveTextContent('ada@example.com');
      pickReason('delete-user-dialog');
      expect(confirmButton('delete-user-dialog')).toBeDisabled();
      expect(hint('delete-user-dialog')).toHaveTextContent('Type the email address exactly to confirm.');

      fireEvent.change(screen.getByTestId('delete-user-dialog-typed-input'), { target: { value: 'ada@example.co' } });
      expect(confirmButton('delete-user-dialog')).toBeDisabled();
      fireEvent.change(screen.getByTestId('delete-user-dialog-typed-input'), { target: { value: 'ADA@example.com' } });
      expect(confirmButton('delete-user-dialog')).toBeDisabled();
      fireEvent.change(screen.getByTestId('delete-user-dialog-typed-input'), { target: { value: 'ada@example.com' } });
      expect(confirmButton('delete-user-dialog')).toBeEnabled();
      fireEvent.click(confirmButton('delete-user-dialog'));

      await waitFor(() =>
        expect(mocks.deleteUser).toHaveBeenCalledWith({ id: USER_ID, reason: 'User requested deletion' })
      );
      expect(onClose).toHaveBeenCalled();
      expect(onDeleted).toHaveBeenCalled();
    });

    it('warns when the delete could not cancel every subscription', async () => {
      mocks.deleteUser.mockResolvedValue({
        subscriptionCancellation: {
          canceled: [],
          failed: [{ customerId: 'cus_1', subscriptionId: null, reason: 'stripe down' }],
        },
      });
      const { onDeleted } = renderDelete();
      pickReason('delete-user-dialog');
      fireEvent.change(screen.getByTestId('delete-user-dialog-typed-input'), { target: { value: 'ada@example.com' } });

      fireEvent.click(confirmButton('delete-user-dialog'));

      await waitFor(() => expect(onDeleted).toHaveBeenCalled());
      expect(mocks.toastWarning).toHaveBeenCalledWith(
        'Could not cancel 1 Stripe subscription(s) of this account. Cancel them in Stripe.'
      );
    });

    it('shows no subscription warning for a plain delete', async () => {
      mocks.deleteUser.mockResolvedValue({ id: USER_ID });
      const { onDeleted } = renderDelete();
      pickReason('delete-user-dialog');
      fireEvent.change(screen.getByTestId('delete-user-dialog-typed-input'), { target: { value: 'ada@example.com' } });

      fireEvent.click(confirmButton('delete-user-dialog'));

      await waitFor(() => expect(onDeleted).toHaveBeenCalled());
      expect(mocks.toastWarning).not.toHaveBeenCalled();
    });

    it('asks for the user id when the account has no email', () => {
      renderDelete(buildProfile({ email: undefined }));

      expect(screen.getByTestId('delete-user-dialog-typed-expected')).toHaveTextContent(USER_ID);
      pickReason('delete-user-dialog');
      expect(hint('delete-user-dialog')).toHaveTextContent('Type the user ID exactly to confirm.');
    });

    it('does not report a deletion that failed', async () => {
      mocks.deleteUser.mockRejectedValue(new Error('nope'));
      const { onClose, onDeleted } = renderDelete();
      pickReason('delete-user-dialog');
      fireEvent.change(screen.getByTestId('delete-user-dialog-typed-input'), { target: { value: 'ada@example.com' } });

      fireEvent.click(confirmButton('delete-user-dialog'));

      await waitFor(() => expect(mocks.deleteUser).toHaveBeenCalled());
      expect(onClose).not.toHaveBeenCalled();
      expect(onDeleted).not.toHaveBeenCalled();
    });
  });

  describe('LoginAsDialog', () => {
    it('stays blocked until a code is typed, then sends it with the reason', async () => {
      const { onClose } = renderDialog((user, close) => <LoginAsDialog user={user} onClose={close} />);

      pickReason('login-as-dialog');
      expect(confirmButton('login-as-dialog')).toBeDisabled();
      expect(hint('login-as-dialog')).toHaveTextContent('Enter your 6-digit authenticator code.');

      fireEvent.change(screen.getByTestId('login-as-dialog-mfa-input'), { target: { value: ' 123456 ' } });
      expect(confirmButton('login-as-dialog')).toBeEnabled();
      fireEvent.click(confirmButton('login-as-dialog'));

      await waitFor(() =>
        expect(mocks.loginAs).toHaveBeenCalledWith({
          id: USER_ID,
          mfaToken: '123456',
          reason: 'Reproduce a reported bug',
        })
      );
      expect(onClose).toHaveBeenCalled();
    });

    it('needs a reason as well as a code', () => {
      renderDialog((user, close) => <LoginAsDialog user={user} onClose={close} />);

      fireEvent.change(screen.getByTestId('login-as-dialog-mfa-input'), { target: { value: '123456' } });

      expect(confirmButton('login-as-dialog')).toBeDisabled();
      expect(hint('login-as-dialog')).toHaveTextContent('Pick a reason');
    });

    it('shows the set-up link, not the code field, when the admin has no authenticator', () => {
      mocks.currentUser = { id: 'admin-1' };
      const { onClose } = renderDialog((user, close) => <LoginAsDialog user={user} onClose={close} />);
      pickReason('login-as-dialog');

      expect(screen.queryByTestId('login-as-dialog-mfa-input')).not.toBeInTheDocument();
      expect(confirmButton('login-as-dialog')).toBeDisabled();
      expect(hint('login-as-dialog')).toHaveTextContent('Set up two-factor on your own account first.');

      fireEvent.click(screen.getByTestId('login-as-dialog-setup-mfa-btn'));

      expect(onClose).toHaveBeenCalled();
      expect(mocks.navigate).toHaveBeenCalledWith({ to: '/profile', search: { tab: 'security' } });
    });
  });

  describe('SendMessageDialog', () => {
    it('is blocked until both a subject and a message are written', async () => {
      const { onClose } = renderDialog((user, close) => <SendMessageDialog user={user} onClose={close} />);
      pickReason('send-message-dialog');

      expect(confirmButton('send-message-dialog')).toBeDisabled();
      expect(hint('send-message-dialog')).toHaveTextContent('Write a subject and a message.');

      fireEvent.change(screen.getByTestId('send-message-dialog-title-input'), { target: { value: '  Heads up  ' } });
      expect(confirmButton('send-message-dialog')).toBeDisabled();
      fireEvent.change(screen.getByTestId('send-message-dialog-message-input'), { target: { value: '   ' } });
      expect(confirmButton('send-message-dialog')).toBeDisabled();
      fireEvent.change(screen.getByTestId('send-message-dialog-message-input'), {
        target: { value: ' Please read. ' },
      });
      expect(confirmButton('send-message-dialog')).toBeEnabled();
      fireEvent.click(confirmButton('send-message-dialog'));

      await waitFor(() =>
        expect(mocks.sendMessage).toHaveBeenCalledWith({
          title: 'Heads up',
          message: 'Please read.',
          receiverId: USER_ID,
          reason: 'Account notice',
        })
      );
      expect(onClose).toHaveBeenCalled();
    });

    it('needs a reason too', () => {
      renderDialog((user, close) => <SendMessageDialog user={user} onClose={close} />);
      fireEvent.change(screen.getByTestId('send-message-dialog-title-input'), { target: { value: 'Subject' } });
      fireEvent.change(screen.getByTestId('send-message-dialog-message-input'), { target: { value: 'Body' } });

      expect(confirmButton('send-message-dialog')).toBeDisabled();
      expect(hint('send-message-dialog')).toHaveTextContent('Pick a reason');
    });
  });
});
