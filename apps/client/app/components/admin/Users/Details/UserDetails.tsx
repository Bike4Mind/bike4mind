import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';

import GrantSubscriptionModal from './GrantSubscriptionModal';
import AdminGenerateApiKeyModal from './AdminGenerateApiKeyModal';
import AdminApiKeysModal from './AdminApiKeysModal';
import MFAStatusBadge from '../MFAStatusBadge';
import { useForceResetMFA } from '@client/app/hooks/data/mfa';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { IUserDocument } from '@bike4mind/common';
import { ActionDialog } from '@client/app/components/admin/shared/ActionDialog';
import { ADMIN_REASON_PRESETS } from '@client/app/components/admin/shared/adminReason';
import KeyIcon from '@mui/icons-material/Key';
import CardGiftcardIcon from '@mui/icons-material/CardGiftcard';
import SecurityIcon from '@mui/icons-material/Security';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import EmailIcon from '@mui/icons-material/Email';
import { Button, Input, Stack, Tooltip, Box, Alert, Typography, Chip, Switch } from '@mui/joy';
import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';

/** The account writes here that the server audits with a required reason. */
type ReasonedAction = 'verify' | 'unverify' | 'trust' | 'untrust';

const REASONED_ACTIONS: Record<
  ReasonedAction,
  { title: string; confirmLabel: string; presets: readonly string[]; tone: 'neutral' | 'danger' }
> = {
  verify: {
    title: 'Verify email',
    confirmLabel: 'Mark verified',
    presets: ADMIN_REASON_PRESETS.emailVerification,
    tone: 'neutral',
  },
  unverify: {
    title: 'Unverify email',
    confirmLabel: 'Mark unverified',
    presets: ADMIN_REASON_PRESETS.emailVerification,
    tone: 'danger',
  },
  trust: {
    title: 'Trust for personal API keys',
    confirmLabel: 'Trust account',
    presets: ADMIN_REASON_PRESETS.apiKeyTrust,
    tone: 'neutral',
  },
  untrust: {
    title: 'Remove API key trust',
    confirmLabel: 'Remove trust',
    presets: ADMIN_REASON_PRESETS.apiKeyTrust,
    tone: 'neutral',
  },
};

interface UserDetailsProps {
  user: AdminUserListItem;
  editedFields: EditedFieldsState;
  onFieldChange: (fieldName: keyof IUserDocument, value: unknown) => void;
}

const UserDetails: React.FC<UserDetailsProps> = ({ user, editedFields, onFieldChange }) => {
  const [organizationName, setOrganizationName] = useState<string | null>(user.organizationId?.name ?? null);
  const [isGrantSubscriptionModalOpen, setIsGrantSubscriptionModalOpen] = useState(false);
  const [isGenerateApiKeyModalOpen, setIsGenerateApiKeyModalOpen] = useState(false);
  const [isApiKeysModalOpen, setIsApiKeysModalOpen] = useState(false);
  const [isMfaResetOpen, setIsMfaResetOpen] = useState(false);
  const [reasonedAction, setReasonedAction] = useState<ReasonedAction | null>(null);
  // Server-confirmed value from the last toggle; overrides the prop until the refetch lands.
  const [apiKeyTrustOverride, setApiKeyTrustOverride] = useState<boolean | null>(null);
  const apiKeyTrustApproved = apiKeyTrustOverride ?? user.apiKeyTrustApproved === true;
  const queryClient = useQueryClient();

  const forceResetMFA = useForceResetMFA();
  const confirm = useConfirmation();

  const verifyEmail = useMutation({
    mutationFn: async (reason: string) => {
      const response = await api.post(`/api/admin/users/${user.id}/verify-email`, { reason });
      return response.data;
    },
    onSuccess: () => {
      // Update local user object immediately
      onFieldChange('emailVerified', true);
      onFieldChange('emailVerifiedAt', new Date());
      // Force refetch to get updated data from server
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.refetchQueries({ queryKey: ['users', user.id] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'email-verification'] });
    },
  });

  const unverifyEmail = useMutation({
    mutationFn: async (reason: string) => {
      const response = await api.post(`/api/admin/users/${user.id}/unverify-email`, { reason });
      return response.data;
    },
    onSuccess: () => {
      // Update local user object immediately
      onFieldChange('emailVerified', false);
      onFieldChange('emailVerifiedAt', null);
      // Force refetch to get updated data from server
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.refetchQueries({ queryKey: ['users', user.id] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'email-verification'] });
    },
  });

  const resendVerification = useMutation({
    mutationFn: async (userId: string) => {
      const response = await api.post(`/api/admin/users/${userId}/resend-verification`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.refetchQueries({ queryKey: ['users', user.id] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'email-verification'] });
    },
  });

  const resendEmailChange = useMutation({
    mutationFn: async (userId: string) => {
      const response = await api.post(`/api/admin/users/${userId}/resend-email-change`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.refetchQueries({ queryKey: ['users', user.id] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'email-verification'] });
    },
  });

  const setApiKeyTrust = useMutation({
    mutationFn: async ({ approved, reason }: { approved: boolean; reason: string }) => {
      const response = await api.post<{ apiKeyTrustApproved: boolean }>(`/api/admin/users/${user.id}/api-key-trust`, {
        approved,
        reason,
      });
      return response.data;
    },
    onSuccess: data => {
      // Held locally rather than via onFieldChange: this writes through its own endpoint, so it must not stage a pending save.
      setApiKeyTrustOverride(data.apiKeyTrustApproved);
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.refetchQueries({ queryKey: ['users', user.id] });
    },
  });

  useEffect(() => {
    setOrganizationName(user.organizationId?.name || '');
  }, [user]);

  // A refetched prop supersedes the local override, including a change another admin made.
  useEffect(() => {
    setApiKeyTrustOverride(null);
  }, [user.apiKeyTrustApproved]);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value;
    onFieldChange('name', newName);
  };

  const handleUserNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newUsername = e.target.value;
    onFieldChange('username', newUsername);
  };

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newEmail = e.target.value;
    onFieldChange('email', newEmail);
  };

  const closeMfaReset = () => setIsMfaResetOpen(false);

  const handleResetMFA = () => setIsMfaResetOpen(true);

  const confirmResetMFA = (reason: string) => {
    forceResetMFA.mutate(
      { userId: user.id, reason },
      {
        onSuccess: () => {
          toast.success('User MFA has been reset successfully');
          closeMfaReset();
        },
        onError: (error: any) => {
          // Extract the actual error message from axios response
          const errorMessage = error.response?.data?.error || error.message || 'Failed to reset user MFA';
          toast.error(errorMessage);
        },
      }
    );
  };

  const descriptions: Record<ReasonedAction, string> = {
    verify: `${user.email} is treated as confirmed without the user clicking the link.`,
    unverify: `${user.email} must be confirmed again before features that need a verified email work.`,
    trust: 'They can create personal API keys without waiting for the account-age or purchase requirement.',
    untrust: 'New personal API keys need the usual account checks again. Existing keys keep working.',
  };

  // A rejection is rethrown so the ActionDialog stays open with the reason the admin typed.
  const confirmReasonedAction = async (reason: string) => {
    if (!reasonedAction) return;
    try {
      switch (reasonedAction) {
        case 'verify':
          await verifyEmail.mutateAsync(reason);
          toast.success(`Email verified for ${user.username}`);
          break;
        case 'unverify':
          await unverifyEmail.mutateAsync(reason);
          toast.success(`Email unverified for ${user.username}`);
          break;
        case 'trust':
        case 'untrust': {
          const approved = reasonedAction === 'trust';
          await setApiKeyTrust.mutateAsync({ approved, reason });
          toast.success(
            approved
              ? `${user.username} is now trusted for personal API keys`
              : `API key trust revoked for ${user.username}`
          );
          break;
        }
      }
      setReasonedAction(null);
    } catch (error) {
      toast.error(
        isAxiosError<{ error?: string; message?: string }>(error)
          ? (error.response?.data?.error ?? error.response?.data?.message ?? error.message)
          : 'The change was not saved'
      );
      throw error;
    }
  };

  const handleResendVerification = () => {
    confirm({
      title: 'Resend Verification Email',
      description: `Are you sure you want to resend the verification email to ${user.email}?`,
      type: 'default',
      onOk: async () => {
        try {
          await resendVerification.mutateAsync(user.id);
          toast.success(`Verification email resent to ${user.email}`);
        } catch (error: any) {
          const errorMessage = error.response?.data?.message || error.message || 'Failed to resend verification email';
          toast.error(errorMessage);
        }
      },
    });
  };

  const handleResendEmailChange = () => {
    confirm({
      title: 'Resend Email Change Verification',
      description: `Are you sure you want to resend the email change verification to ${user.pendingEmail}?`,
      type: 'default',
      onOk: async () => {
        try {
          await resendEmailChange.mutateAsync(user.id);
          toast.success(`Email change verification resent to ${user.pendingEmail}`);
        } catch (error: any) {
          // Backend sends error message in 'error' field, not 'message'
          const errorMessage =
            error.response?.data?.error ||
            error.response?.data?.message ||
            error.message ||
            'Failed to resend email change verification';
          toast.error(errorMessage);

          // Refresh user data to reflect any backend state changes (e.g., expired token auto-cancelled)
          queryClient.invalidateQueries({ queryKey: ['users'] });
          queryClient.refetchQueries({ queryKey: ['users', user.id] });
        }
      },
    });
  };

  return (
    <>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {/* User Edit Form */}
        <Stack direction="column" spacing={1}>
          <Tooltip title="Name">
            <Input
              size="sm"
              sx={{ borderColor: editedFields?.name ? 'danger.500' : 'default' }}
              value={user.name}
              onChange={handleNameChange}
            />
          </Tooltip>
          <Tooltip title="User Name">
            <Input
              size="sm"
              sx={{ borderColor: editedFields?.username ? 'danger.500' : 'default' }}
              value={user.username}
              onChange={handleUserNameChange}
            />
          </Tooltip>
          <Tooltip title="Email">
            <Input
              size="sm"
              sx={{ borderColor: editedFields?.email ? 'danger.500' : 'default' }}
              value={user.email || ''}
              onChange={handleEmailChange}
            />
          </Tooltip>
          <Tooltip title={organizationName || 'No organization'}>
            <Input size="sm" value={organizationName || 'No organization'} readOnly />
          </Tooltip>
          {/* MFA Status */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              p: 2,
              bgcolor: 'background.level1',
              borderRadius: 'md',
            }}
          >
            <Typography level="body-sm" sx={{ fontWeight: 'bold' }}>
              MFA Status:
            </Typography>
            <MFAStatusBadge user={user} size="md" />
          </Box>

          {/* Email Verification Status */}
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              p: 2,
              bgcolor: 'background.level1',
              borderRadius: 'md',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Typography level="body-sm" sx={{ fontWeight: 'bold' }}>
                Email Status:
              </Typography>
              {user.pendingEmail ? (
                <Chip size="md" color="primary" startDecorator={<EmailIcon />}>
                  Changing Email
                </Chip>
              ) : user.emailVerified ? (
                <Chip size="md" color="success" startDecorator={<CheckCircleIcon />}>
                  Verified
                </Chip>
              ) : (
                <Chip size="md" color="warning" startDecorator={<EmailIcon />}>
                  Unverified
                </Chip>
              )}
            </Box>
            {user.pendingEmail && (
              <Typography level="body-xs" sx={{ color: 'text.secondary', ml: 1 }}>
                Pending: {user.email} →{' '}
                <strong style={{ color: 'var(--joy-palette-primary-main)' }}>{user.pendingEmail}</strong>
              </Typography>
            )}
          </Box>

          {/* Password change/reset hidden - passwordless OTC login, no user passwords */}

          <Button
            startDecorator={<SecurityIcon />}
            color="danger"
            variant="outlined"
            onClick={handleResetMFA}
            loading={forceResetMFA.isPending}
            disabled={!user.mfa || !user.mfa.totpEnabled}
          >
            Reset MFA
          </Button>

          {/* Email Verification Actions */}
          {user.pendingEmail ? (
            <Button
              startDecorator={<EmailIcon />}
              color="primary"
              variant="solid"
              onClick={handleResendEmailChange}
              loading={resendEmailChange.isPending}
            >
              Resend Email Change
            </Button>
          ) : user.emailVerified ? (
            <Button
              startDecorator={<CancelIcon />}
              color="danger"
              variant="outlined"
              onClick={() => setReasonedAction('unverify')}
              loading={unverifyEmail.isPending}
            >
              Unverify Email
            </Button>
          ) : (
            <Stack direction="row" spacing={1}>
              <Button
                startDecorator={<CheckCircleIcon />}
                color="success"
                variant="solid"
                onClick={() => setReasonedAction('verify')}
                loading={verifyEmail.isPending}
                sx={{ flex: 1 }}
              >
                Verify Email
              </Button>
              <Button
                startDecorator={<EmailIcon />}
                color="primary"
                variant="outlined"
                onClick={handleResendVerification}
                loading={resendVerification.isPending}
                sx={{ flex: 1 }}
              >
                Resend Verification
              </Button>
            </Stack>
          )}

          <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
            <Box>
              <Typography level="title-sm">Trusted for personal API keys</Typography>
              <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                Trust this account for personal API keys without waiting for the account-age or purchase requirement.
                Email must still be verified.
              </Typography>
            </Box>
            <Switch
              checked={apiKeyTrustApproved}
              disabled={setApiKeyTrust.isPending}
              onChange={event => setReasonedAction(event.target.checked ? 'trust' : 'untrust')}
              slotProps={{
                input: {
                  'aria-label': 'Trusted for personal API keys',
                  'data-testid': 'admin-user-api-key-trust-toggle',
                },
              }}
            />
          </Box>

          <Button
            startDecorator={<CardGiftcardIcon />}
            color="success"
            variant="solid"
            onClick={() => setIsGrantSubscriptionModalOpen(true)}
          >
            Grant Subscription
          </Button>

          <Button
            startDecorator={<KeyIcon />}
            color="primary"
            variant="solid"
            onClick={() => setIsGenerateApiKeyModalOpen(true)}
          >
            Generate API Key
          </Button>

          <Button
            startDecorator={<KeyIcon />}
            color="neutral"
            variant="outlined"
            onClick={() => setIsApiKeysModalOpen(true)}
            data-testid="admin-api-keys-btn"
          >
            View API Keys
          </Button>

          {user.mfa && user.mfa.totpEnabled && (
            <Alert color="neutral" size="sm">
              User has MFA enabled since {new Date(user.mfa.setupAt).toLocaleDateString()}
              {user.mfa.lastUsedAt && <>, last used {new Date(user.mfa.lastUsedAt).toLocaleDateString()}</>}
            </Alert>
          )}
        </Stack>
      </Box>

      <ActionDialog
        open={isMfaResetOpen}
        onClose={closeMfaReset}
        title="Reset MFA"
        description={`Turns off MFA for ${user.name}. They must set it up again at their next sign-in.`}
        reasonPresets={ADMIN_REASON_PRESETS.mfaReset}
        confirmLabel="Reset MFA"
        tone="danger"
        pending={forceResetMFA.isPending}
        onConfirm={confirmResetMFA}
        data-testid="mfa-reset-modal"
        testIds={{ reason: 'mfa-reset-reason-input', confirm: 'mfa-reset-confirm-btn' }}
      />

      {reasonedAction && (
        <ActionDialog
          open
          onClose={() => setReasonedAction(null)}
          title={REASONED_ACTIONS[reasonedAction].title}
          description={descriptions[reasonedAction]}
          reasonPresets={REASONED_ACTIONS[reasonedAction].presets}
          confirmLabel={REASONED_ACTIONS[reasonedAction].confirmLabel}
          tone={REASONED_ACTIONS[reasonedAction].tone}
          onConfirm={confirmReasonedAction}
          data-testid="user-details-reason-modal"
        />
      )}

      <GrantSubscriptionModal
        user={user}
        open={isGrantSubscriptionModalOpen}
        onClose={() => setIsGrantSubscriptionModalOpen(false)}
      />

      <AdminGenerateApiKeyModal
        user={user}
        open={isGenerateApiKeyModalOpen}
        onClose={() => setIsGenerateApiKeyModalOpen(false)}
      />

      <AdminApiKeysModal user={user} open={isApiKeysModalOpen} onClose={() => setIsApiKeysModalOpen(false)} />
    </>
  );
};

export default UserDetails;
