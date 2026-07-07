import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { useUser } from '@client/app/contexts/UserContext';
import {
  Box,
  Typography,
  Button,
  Input,
  FormControl,
  FormLabel,
  Alert,
  Modal,
  ModalDialog,
  ModalClose,
  Stack,
  Chip,
} from '@mui/joy';
import EmailIcon from '@mui/icons-material/Email';
import EditIcon from '@mui/icons-material/Edit';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningIcon from '@mui/icons-material/Warning';
import { useState, useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearch, useNavigate } from '@tanstack/react-router';
import { api } from '@client/app/contexts/ApiContext';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

const RESEND_COOLDOWN_SECONDS = 60;

// Deep-link action from the "Cancel Email Change" button in the security-alert
// email (see the cancelUrl built in `pages/api/email/change.ts`). Landing on
// `/profile?action=cancel-email-change` opens the cancel confirmation dialog.
const CANCEL_EMAIL_CHANGE_ACTION = 'cancel-email-change';

const useRequestEmailChange = () => {
  const queryClient = useQueryClient();
  const refreshUser = useUser(state => state.refreshUser);

  return useMutation({
    mutationFn: async (data: { newEmail: string }) => {
      const response = await api.post('/api/email/change', data);
      return response.data;
    },
    onSuccess: async () => {
      // Refresh user to get updated pendingEmail
      await refreshUser();
      queryClient.invalidateQueries({ queryKey: ['user'] });
    },
  });
};

const useCancelEmailChange = () => {
  const queryClient = useQueryClient();
  const refreshUser = useUser(state => state.refreshUser);

  return useMutation({
    mutationFn: async () => {
      const response = await api.post('/api/email/cancel-change');
      return response.data;
    },
    onSuccess: async () => {
      // Refresh user to clear pendingEmail
      await refreshUser();
      queryClient.invalidateQueries({ queryKey: ['user'] });
    },
  });
};

interface ChangeEmailModalProps {
  open: boolean;
  onClose: () => void;
  currentEmail: string;
}

const ChangeEmailModal = ({ open, onClose, currentEmail }: ChangeEmailModalProps) => {
  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const { t } = useTranslation();

  const requestChange = useRequestEmailChange();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!newEmail) {
      setError('Please enter a new email address');
      return;
    }

    if (newEmail === currentEmail) {
      setError('New email must be different from current email');
      return;
    }

    try {
      await requestChange.mutateAsync({ newEmail });
      setSuccess('Verification email sent! Please check your new email address.');
      setNewEmail('');

      setTimeout(() => {
        onClose();
        setSuccess(null);
      }, 1500);
    } catch (err: unknown) {
      const apiErr = err as { response?: { status?: number; data?: { message?: string } }; message?: string };
      if (apiErr.response?.status === 429) {
        setError(
          "You've reached the limit for email change requests (3 per 15 minutes). Please wait before trying again."
        );
      } else if (apiErr.response?.data?.message) {
        setError(apiErr.response.data.message);
      } else if (apiErr.message) {
        setError(apiErr.message);
      } else {
        setError('Failed to request email change. Please try again later.');
      }
    }
  };

  const handleClose = () => {
    onClose();
    setError(null);
    setSuccess(null);
    setNewEmail('');
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog size="md" sx={{ maxWidth: 500 }}>
        <ModalClose />
        <Typography level="h4" mb={2}>
          Change Email Address
        </Typography>

        <form onSubmit={handleSubmit}>
          <Stack spacing={2}>
            <Alert color="primary" variant="soft">
              <Typography level="body-sm">
                You&apos;ll receive a verification email at your new address. Your email won&apos;t change until you
                click the verification link.
              </Typography>
            </Alert>

            <FormControl>
              <FormLabel>Current Email</FormLabel>
              <Input value={currentEmail} disabled />
            </FormControl>

            <FormControl required>
              <FormLabel>New Email</FormLabel>
              <Input
                type="email"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                placeholder="Enter new email address"
                autoComplete="email"
              />
            </FormControl>

            {error && <Alert color="danger">{error}</Alert>}
            {success && (
              <Alert color="success" startDecorator={<CheckCircleIcon />}>
                {success}
              </Alert>
            )}

            <Stack direction="row" spacing={2} justifyContent="flex-end">
              <Button variant="outlined" onClick={handleClose} disabled={requestChange.isPending || !!success}>
                Cancel
              </Button>
              <Button type="submit" loading={requestChange.isPending} disabled={requestChange.isPending || !!success}>
                {t('profile.request_change', { defaultValue: 'Request Change' })}
              </Button>
            </Stack>
          </Stack>
        </form>
      </ModalDialog>
    </Modal>
  );
};

const ChangeEmailCard = () => {
  const { currentUser } = useUser();
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const { t } = useTranslation();
  const cancelChange = useCancelEmailChange();
  const search = useSearch({ strict: false }) as { action?: string };
  const navigate = useNavigate();
  const handledCancelActionRef = useRef(false);

  const resendVerification = useMutation({
    mutationFn: async () => {
      const response = await api.post('/api/email/resend-verification');
      return response.data;
    },
    onSuccess: () => {
      toast.success('Verification email sent! Please check your inbox.');
    },
    onError: (error: unknown) => {
      const err = error as { response?: { status?: number; data?: { message?: string; isConfigError?: boolean } } };
      if (err.response?.status === 429) {
        toast.error('Too many requests. Please wait 15 minutes before trying again.');
      } else if (err.response?.data?.message) {
        toast.error(err.response.data.message);
      } else {
        toast.error('Failed to send verification email. Please try again later.');
      }
    },
  });

  // Countdown timer for cooldown
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = setTimeout(() => setCooldownSeconds(s => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldownSeconds]);

  // Handle the `?action=cancel-email-change` deep link from the security-alert
  // email. Open the confirmation dialog rather than cancelling outright: an
  // email client or link scanner that pre-fetches the URL must not be able to
  // silently cancel a legitimate change - an explicit click is still required.
  // Wait until `pendingEmail` has loaded (via /api/identify) before acting, and
  // strip the param afterward so a reload or back-nav doesn't reopen the dialog.
  useEffect(() => {
    if (search?.action !== CANCEL_EMAIL_CHANGE_ACTION) return;
    if (handledCancelActionRef.current) return;
    if (!currentUser?.pendingEmail) return;
    handledCancelActionRef.current = true;
    // Intentional one-shot deep-link handler (ref-guarded): open the dialog in
    // response to the URL param. This is a URL->UI sync, not a render cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfirmCancelOpen(true);
    const { action: _action, ...rest } = search;
    navigate({ to: '/profile', search: rest, replace: true });
  }, [search, currentUser?.pendingEmail, navigate]);

  if (!currentUser?.email) {
    return null;
  }

  const hasPendingChange = !!currentUser.pendingEmail;

  const handleCancelClick = () => {
    setConfirmCancelOpen(true);
  };

  const handleCancelConfirm = async () => {
    setConfirmCancelOpen(false);
    try {
      await cancelChange.mutateAsync();
      toast.success('Email change cancelled successfully');
    } catch (err: unknown) {
      const apiErr = err as { response?: { data?: { message?: string } }; message?: string };
      toast.error(apiErr.response?.data?.message || apiErr.message || 'Failed to cancel email change');
    }
  };

  return (
    <>
      <SectionContainer>
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { xs: 'stretch', sm: 'center' },
            flexWrap: 'wrap',
            gap: 2,
            p: 2,
          }}
        >
          <EmailIcon sx={{ fontSize: 32, color: 'primary.main', flexShrink: 0 }} />

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="title-md" sx={{ mb: 0.5 }}>
              {t('profile.email_address', { defaultValue: 'Email Address' })}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, mb: 1 }}>
              <Typography level="body-sm" sx={{ color: 'text.secondary', wordBreak: 'break-word' }}>
                {currentUser.email}
              </Typography>
              {currentUser.emailVerified ? (
                <Chip size="sm" color="success" variant="soft">
                  Verified
                </Chip>
              ) : (
                <Chip size="sm" color="warning" variant="soft">
                  Not Verified
                </Chip>
              )}
            </Box>

            {hasPendingChange && (
              <Alert color="warning" variant="soft" sx={{ mt: 1 }} data-testid="profile-pending-email-alert">
                <Typography level="body-sm">
                  <strong>Pending:</strong> {currentUser.pendingEmail}
                  <br />
                  <Typography level="body-xs">Check your email to confirm the change</Typography>
                </Typography>
              </Alert>
            )}
          </Box>

          <Stack spacing={1} sx={{ flexShrink: 0, width: { xs: '100%', sm: 'auto' } }}>
            {hasPendingChange ? (
              <Button
                size="sm"
                variant="outlined"
                color="danger"
                onClick={handleCancelClick}
                loading={cancelChange.isPending}
                data-testid="profile-cancel-email-change-btn"
              >
                {t('profile.cancel_change', { defaultValue: 'Cancel' })}
              </Button>
            ) : (
              <>
                {!currentUser.emailVerified && (
                  <Button
                    size="sm"
                    variant="soft"
                    color="warning"
                    startDecorator={<EmailIcon />}
                    loading={resendVerification.isPending}
                    disabled={cooldownSeconds > 0}
                    data-testid="profile-resend-verification-btn"
                    onClick={() => {
                      if (cooldownSeconds > 0) return;
                      resendVerification.mutate();
                      setCooldownSeconds(RESEND_COOLDOWN_SECONDS);
                    }}
                  >
                    {cooldownSeconds > 0 ? `Resend in ${cooldownSeconds}s` : 'Verify'}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outlined"
                  startDecorator={<EditIcon />}
                  onClick={() => setModalOpen(true)}
                  data-testid="profile-change-email-btn"
                >
                  {t('profile.change_email', { defaultValue: 'Change' })}
                </Button>
              </>
            )}
          </Stack>
        </Box>
      </SectionContainer>

      <ChangeEmailModal open={modalOpen} onClose={() => setModalOpen(false)} currentEmail={currentUser.email} />

      {/* Confirmation Modal for Cancelling Email Change */}
      <Modal open={confirmCancelOpen} onClose={() => setConfirmCancelOpen(false)}>
        <ModalDialog size="sm" variant="outlined">
          <ModalClose />
          <Typography level="h4" startDecorator={<WarningIcon />}>
            Cancel Email Change
          </Typography>
          <Typography level="body-md" sx={{ mt: 1 }}>
            Are you sure you want to cancel the pending email change to <strong>{currentUser.pendingEmail}</strong>?
          </Typography>
          <Stack direction="row" spacing={2} justifyContent="flex-end" sx={{ mt: 3 }}>
            <Button
              variant="outlined"
              color="neutral"
              onClick={() => setConfirmCancelOpen(false)}
              data-testid="profile-cancel-email-dismiss-btn"
            >
              No, Keep It
            </Button>
            <Button
              color="danger"
              onClick={handleCancelConfirm}
              loading={cancelChange.isPending}
              data-testid="profile-cancel-email-confirm-btn"
            >
              Yes, Cancel Change
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default ChangeEmailCard;
