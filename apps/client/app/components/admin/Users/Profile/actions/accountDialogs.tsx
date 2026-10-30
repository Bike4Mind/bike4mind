import React, { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FormControl, FormLabel, Input, Stack, Textarea, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { isThrottleExempt } from '@bike4mind/common';
import { useDeleteUser, useLoginAsUser } from '@client/app/hooks/data/user';
import { useForceResetMFA } from '@client/app/hooks/data/mfa';
import { useSendSystemMessage } from '@client/app/hooks/data/inbox';
import { ActionDialog, ADMIN_REASON_PRESETS, ChangePreview, undoAdminReason, useUndoToast } from '../../../shared';
import { useAdminUserUpdate, adminUpdateErrorMessage } from './useAdminUserUpdate';
import type { ProfileDialogProps } from './profileActions';
import { accountStatus, displayName } from '../userProfileModel';

/** POST to one of the admin user endpoints, refresh the user, toast a failure and rethrow it. */
const useAdminUserPost = (userId: string, failure: string) => {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: Record<string, unknown> }) =>
      (await api.post(`/api/admin/users/${encodeURIComponent(userId)}/${path}`, body)).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'email-verification'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users', userId] });
    },
  });
  return async (path: string, body?: Record<string, unknown>) => {
    try {
      return await mutation.mutateAsync({ path, body });
    } catch (error) {
      toast.error(adminUpdateErrorMessage(error, failure));
      throw error;
    }
  };
};

/** Restrict blocks AI features but keeps sign-in; lifting it is the same dialog in reverse. */
export const RestrictDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const update = useAdminUserUpdate(user.id);
  const showUndo = useUndoToast();
  const restricting = !user.isModerated;
  const before = accountStatus(user);
  const after = accountStatus({ ...user, isModerated: restricting });

  const handleConfirm = async (reason: string) => {
    await update({ isModerated: restricting, statusChangeReason: reason });
    onClose();
    showUndo({
      message: restricting ? 'Account restricted' : 'Restriction lifted',
      onUndo: () => update({ isModerated: !restricting, statusChangeReason: undoAdminReason(reason) }),
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={restricting ? `Restrict ${displayName(user)}?` : `Lift the restriction on ${displayName(user)}?`}
      description={
        restricting
          ? 'They can still sign in and see their data, but cannot use AI features until the restriction is lifted.'
          : 'AI features work again right away.'
      }
      reasonPresets={restricting ? ADMIN_REASON_PRESETS.restriction : ADMIN_REASON_PRESETS.reinstatement}
      confirmLabel={restricting ? 'Restrict account' : 'Lift restriction'}
      tone={restricting ? 'danger' : 'neutral'}
      onConfirm={handleConfirm}
      data-testid="restrict-dialog"
    >
      <ChangePreview before={before.label} after={after.label} data-testid="restrict-dialog-preview" />
    </ActionDialog>
  );
};

const dateOnly = (value?: Date | string | null): string => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '-';
};

/** Sets or clears the silent limited tier; limits are admin settings (shadowTier*). */
export const ShadowTierDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const update = useAdminUserUpdate(user.id);
  const showUndo = useUndoToast();
  const restricting = user.throttle?.tier !== 'shadow';
  const signals = user.riskSignals ?? [];

  const handleConfirm = async (reason: string) => {
    await update({ throttleTier: restricting ? 'shadow' : 'none', throttleReason: reason });
    onClose();
    showUndo({
      message: restricting ? 'Moved to limited tier' : 'Limited tier removed',
      onUndo: () =>
        update({ throttleTier: restricting ? 'none' : 'shadow', throttleReason: `Undo: ${reason}`.slice(0, 500) }),
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={
        restricting
          ? `Move ${displayName(user)} to the limited tier?`
          : `Remove ${displayName(user)} from the limited tier?`
      }
      description={
        restricting
          ? 'Limits them to cheap models, a low request rate and a daily token cap. They are not told.'
          : 'Their models, request rate and token cap return to normal right away.'
      }
      reasonPresets={restricting ? ADMIN_REASON_PRESETS.limitedTier : ADMIN_REASON_PRESETS.limitedTierLift}
      confirmLabel={restricting ? 'Move to limited tier' : 'Remove limited tier'}
      tone={restricting ? 'danger' : 'neutral'}
      onConfirm={handleConfirm}
      data-testid="profile-shadow-tier-dialog"
    >
      <Stack gap={0.5} data-testid="profile-shadow-tier-state">
        <Typography level="body-sm" data-testid="profile-shadow-tier-current">
          {user.throttle
            ? `Tier ${user.throttle.tier === 'shadow' ? 'limited' : 'standard'}, source ${user.throttle.source ?? '-'}, changed ${dateOnly(user.throttle.changedAt)}.`
            : 'Tier standard. Never changed.'}
        </Typography>
        <Typography level="body-sm" data-testid="profile-shadow-tier-signals">
          {signals.length
            ? `Signals: ${signals.map(signal => `${signal.type} (${dateOnly(signal.at)})`).join(', ')}`
            : 'No signals'}
        </Typography>
        {isThrottleExempt(user) && (
          <Typography level="body-sm" color="warning" data-testid="profile-shadow-tier-exempt">
            Not in effect: admins and Developer-tagged users are never limited.
          </Typography>
        )}
      </Stack>
    </ActionDialog>
  );
};

export const EmailVerificationDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const post = useAdminUserPost(user.id, 'The email status was not changed.');
  const showUndo = useUndoToast();
  const verifying = !user.emailVerified;
  const label = (verified: boolean) => (verified ? 'Verified' : 'Unverified');

  const handleConfirm = async (reason: string) => {
    await post(verifying ? 'verify-email' : 'unverify-email', { reason });
    onClose();
    showUndo({
      message: verifying ? 'Email marked verified' : 'Email marked unverified',
      onUndo: () => post(verifying ? 'unverify-email' : 'verify-email', { reason: undoAdminReason(reason) }),
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={verifying ? 'Mark email verified' : 'Mark email unverified'}
      description={
        verifying
          ? `${user.email} is treated as confirmed without the user clicking the link.`
          : `${user.email} must be confirmed again before features that need a verified email work.`
      }
      reasonPresets={ADMIN_REASON_PRESETS.emailVerification}
      confirmLabel={verifying ? 'Mark verified' : 'Mark unverified'}
      onConfirm={handleConfirm}
      data-testid="email-verification-dialog"
    >
      <ChangePreview
        before={label(!!user.emailVerified)}
        after={label(verifying)}
        data-testid="email-verification-dialog-preview"
      />
    </ActionDialog>
  );
};

export const ApiKeyTrustDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const post = useAdminUserPost(user.id, 'API key trust was not changed.');
  const showUndo = useUndoToast();
  const approving = !user.apiKeyTrustApproved;
  const label = (trusted: boolean) => (trusted ? 'Trusted' : 'Not trusted');

  const handleConfirm = async (reason: string) => {
    await post('api-key-trust', { approved: approving, reason });
    onClose();
    showUndo({
      message: approving ? 'Trusted for personal API keys' : 'API key trust removed',
      onUndo: () => post('api-key-trust', { approved: !approving, reason: undoAdminReason(reason) }),
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={approving ? 'Trust for personal API keys' : 'Remove API key trust'}
      description={
        approving
          ? 'They can create personal API keys without the usual account checks.'
          : 'New personal API keys need the usual account checks again. Existing keys keep working.'
      }
      reasonPresets={ADMIN_REASON_PRESETS.apiKeyTrust}
      confirmLabel={approving ? 'Trust account' : 'Remove trust'}
      onConfirm={handleConfirm}
      data-testid="api-key-trust-dialog"
    >
      <ChangePreview
        before={label(!!user.apiKeyTrustApproved)}
        after={label(approving)}
        data-testid="api-key-trust-dialog-preview"
      />
    </ActionDialog>
  );
};

/** No undo: the user re-enrols their authenticator. */
export const ResetMfaDialog: React.FC<ProfileDialogProps> = ({ user, onClose }) => {
  const resetMfa = useForceResetMFA();
  const queryClient = useQueryClient();

  const handleConfirm = async (reason: string) => {
    try {
      await resetMfa.mutateAsync({ userId: user.id, reason });
    } catch (error) {
      toast.error(adminUpdateErrorMessage(error, 'Two-factor was not reset.'));
      throw error;
    }
    void queryClient.invalidateQueries({ queryKey: ['users'] });
    toast.success('Two-factor reset. They set it up again at next sign-in.');
    onClose();
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Reset two-factor"
      description={`Removes ${displayName(user)}'s authenticator. They set up a new one the next time they sign in. This cannot be undone.`}
      reasonPresets={ADMIN_REASON_PRESETS.mfaReset}
      confirmLabel="Reset two-factor"
      tone="danger"
      onConfirm={handleConfirm}
      data-testid="mfa-reset-dialog"
    >
      <ChangePreview before="Authenticator app" after="Not set up" data-testid="mfa-reset-dialog-preview" />
    </ActionDialog>
  );
};

/** Irreversible: the admin types the account email (or id) before the commit unlocks. */
export const DeleteUserDialog: React.FC<ProfileDialogProps & { onDeleted: () => void }> = ({
  user,
  onClose,
  onDeleted,
}) => {
  const deleteUser = useDeleteUser();

  const handleConfirm = async (reason: string) => {
    await deleteUser.mutateAsync({ id: user.id, reason });
    onClose();
    onDeleted();
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`Delete ${displayName(user)}`}
      description="Permanently removes this user and all their data. There is no undo; suspend them instead if you might need to restore access."
      reasonPresets={ADMIN_REASON_PRESETS.userDeletion}
      typedConfirm={
        user.email ? { expected: user.email, noun: 'email address' } : { expected: user.id, noun: 'user ID' }
      }
      confirmLabel="Delete user permanently"
      tone="danger"
      onConfirm={handleConfirm}
      data-testid="delete-user-dialog"
    />
  );
};

/** Impersonation: step-up with the admin's own authenticator code; the session is audited and time-boxed. */
export const LoginAsDialog: React.FC<ProfileDialogProps> = ({ user, onClose }) => {
  const { currentUser } = useUser();
  const navigate = useNavigate();
  const loginAs = useLoginAsUser();
  const [mfaToken, setMfaToken] = useState('');
  const name = displayName(user);
  const adminHasMfa = !!currentUser?.mfa?.totpEnabled;

  const handleConfirm = async (reason: string) => {
    await loginAs.mutateAsync({ id: user.id, mfaToken: mfaToken.trim(), reason });
    onClose();
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`Log in as ${name}`}
      description={`Starts an audited, time-boxed session as ${name}. Everything you do is recorded against your account.`}
      reasonPresets={ADMIN_REASON_PRESETS.impersonation}
      confirmLabel={`Log in as ${name}`}
      blockedReason={
        !adminHasMfa
          ? 'Set up two-factor on your own account first.'
          : mfaToken.trim()
            ? null
            : 'Enter your 6-digit authenticator code.'
      }
      onConfirm={handleConfirm}
      data-testid="login-as-dialog"
    >
      {adminHasMfa ? (
        <FormControl>
          <FormLabel>Your authenticator code</FormLabel>
          <Input
            autoFocus
            placeholder="6-digit code"
            value={mfaToken}
            onChange={event => setMfaToken(event.target.value)}
            slotProps={{
              input: { maxLength: 10, autoComplete: 'one-time-code', 'data-testid': 'login-as-dialog-mfa-input' },
            }}
          />
        </FormControl>
      ) : (
        <Typography level="body-sm">
          Logging in as a user needs two-factor on your own account.{' '}
          <Typography
            component="button"
            type="button"
            onClick={() => {
              onClose();
              void navigate({ to: '/profile', search: { tab: 'settings', section: 'security' } });
            }}
            sx={{ color: 'admin.link', bgcolor: 'transparent', border: 0, p: 0, cursor: 'pointer', font: 'inherit' }}
            data-testid="login-as-dialog-setup-mfa-btn"
          >
            Set up two-factor
          </Typography>
        </Typography>
      )}
    </ActionDialog>
  );
};

/** Sends an inbox message from the system. Not reversible once read, so no undo. */
export const SendMessageDialog: React.FC<ProfileDialogProps> = ({ user, onClose }) => {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const send = useSendSystemMessage();

  const handleConfirm = async (reason: string) => {
    await send.mutateAsync({ title: title.trim(), message: message.trim(), receiverId: user.id, reason });
    onClose();
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Send message"
      description={`Lands in ${displayName(user)}'s inbox from Bike4Mind.`}
      reasonPresets={ADMIN_REASON_PRESETS.systemMessage}
      confirmLabel="Send message"
      blockedReason={title.trim() && message.trim() ? null : 'Write a subject and a message.'}
      onConfirm={handleConfirm}
      data-testid="send-message-dialog"
    >
      <FormControl>
        <FormLabel>Subject</FormLabel>
        <Input
          autoFocus
          value={title}
          onChange={event => setTitle(event.target.value)}
          slotProps={{ input: { maxLength: 200, 'data-testid': 'send-message-dialog-title-input' } }}
        />
      </FormControl>
      <FormControl>
        <FormLabel>Message</FormLabel>
        <Textarea
          minRows={3}
          value={message}
          onChange={event => setMessage(event.target.value)}
          slotProps={{ textarea: { maxLength: 5000, 'data-testid': 'send-message-dialog-message-input' } }}
        />
      </FormControl>
    </ActionDialog>
  );
};
