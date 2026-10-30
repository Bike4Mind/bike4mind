import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  ApiKeyTrustDialog,
  DeleteUserDialog,
  EmailVerificationDialog,
  LoginAsDialog,
  ResetMfaDialog,
  RestrictDialog,
  SendMessageDialog,
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
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

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
      expect(mocks.navigate).toHaveBeenCalledWith({ to: '/profile', search: { tab: 'settings', section: 'security' } });
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
