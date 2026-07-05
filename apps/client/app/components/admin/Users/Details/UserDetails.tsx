import { EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';

import GrantSubscriptionModal from './GrantSubscriptionModal';
import AdminGenerateApiKeyModal from './AdminGenerateApiKeyModal';
import MFAStatusBadge from '../MFAStatusBadge';
import { useForceResetMFA } from '@client/app/hooks/data/mfa';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { IUserDocument, WithOrgRef } from '@bike4mind/common';
import KeyIcon from '@mui/icons-material/Key';
import CardGiftcardIcon from '@mui/icons-material/CardGiftcard';
import SecurityIcon from '@mui/icons-material/Security';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import EmailIcon from '@mui/icons-material/Email';
import { Button, Input, Stack, Tooltip, Box, Alert, Typography, Chip } from '@mui/joy';
import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

interface UserDetailsProps {
  user: WithOrgRef<IUserDocument>;
  editedFields: EditedFieldsState;
  onFieldChange: (fieldName: keyof IUserDocument, value: unknown) => void;
}

const UserDetails: React.FC<UserDetailsProps> = ({ user, editedFields, onFieldChange }) => {
  const [organizationName, setOrganizationName] = useState<string | null>(user.organizationId?.name ?? null);
  const [isGrantSubscriptionModalOpen, setIsGrantSubscriptionModalOpen] = useState(false);
  const [isGenerateApiKeyModalOpen, setIsGenerateApiKeyModalOpen] = useState(false);
  const queryClient = useQueryClient();

  const forceResetMFA = useForceResetMFA();
  const confirm = useConfirmation();

  const verifyEmail = useMutation({
    mutationFn: async (userId: string) => {
      const response = await api.post(`/api/admin/users/${userId}/verify-email`);
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
    mutationFn: async (userId: string) => {
      const response = await api.post(`/api/admin/users/${userId}/unverify-email`);
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

  useEffect(() => {
    setOrganizationName(user.organizationId?.name || '');
  }, [user]);

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

  const handleResetMFA = () => {
    confirm({
      title: 'Reset User MFA',
      description: `Are you sure you want to reset MFA for ${user.name}? This will disable their current MFA setup and they will need to set it up again.`,
      type: 'danger',
      onOk: () => {
        forceResetMFA.mutate(
          { userId: user.id },
          {
            onSuccess: () => {
              toast.success('User MFA has been reset successfully');
            },
            onError: (error: any) => {
              // Extract the actual error message from axios response
              const errorMessage = error.response?.data?.error || error.message || 'Failed to reset user MFA';
              toast.error(errorMessage);
            },
          }
        );
      },
    });
  };

  const handleVerifyEmail = () => {
    confirm({
      title: 'Verify Email',
      description: `Are you sure you want to manually verify the email for ${user.username} (${user.email})?`,
      type: 'success',
      onOk: async () => {
        try {
          await verifyEmail.mutateAsync(user.id);
          toast.success(`Email verified for ${user.username}`);
        } catch (error: any) {
          const errorMessage = error.response?.data?.message || error.message || 'Failed to verify email';
          toast.error(errorMessage);
        }
      },
    });
  };

  const handleUnverifyEmail = () => {
    confirm({
      title: 'Unverify Email',
      description: `Are you sure you want to unverify the email for ${user.username} (${user.email})? This will require the user to verify their email again.`,
      type: 'danger',
      onOk: async () => {
        try {
          await unverifyEmail.mutateAsync(user.id);
          toast.success(`Email unverified for ${user.username}`);
        } catch (error: any) {
          const errorMessage = error.response?.data?.message || error.message || 'Failed to unverify email';
          toast.error(errorMessage);
        }
      },
    });
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
              onClick={handleUnverifyEmail}
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
                onClick={handleVerifyEmail}
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

          {user.mfa && user.mfa.totpEnabled && (
            <Alert color="neutral" size="sm">
              User has MFA enabled since {new Date(user.mfa.setupAt).toLocaleDateString()}
              {user.mfa.lastUsedAt && <>, last used {new Date(user.mfa.lastUsedAt).toLocaleDateString()}</>}
            </Alert>
          )}
        </Stack>
      </Box>

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
    </>
  );
};

export default UserDetails;
