import React, { useState, useEffect, useMemo } from 'react';
import { useUser } from '@client/app/contexts/UserContext';

import {
  DialogContent,
  Button,
  Modal,
  ModalDialog,
  Typography,
  Textarea,
  Stack,
  IconButton,
  CircularProgress,
  Box,
  Input,
  FormLabel,
  FormControl,
} from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import { toast } from 'sonner';
import { useSubmitUserInvitation, useSubmitReferral } from '@client/app/hooks/data/regInvites';
import type { IReferralResult } from '@client/app/utils/regInviteAPICalls';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import { useServerSettings } from '@client/app/contexts/UserSettingsContext';
import { green, blue, blackAlpha } from '@client/app/utils/themes/colors';

export enum ReferralInviteType {
  referral = 'referral',
  userInvitation = 'userInvitation',
}

interface ReferralModalProps {
  tags?: string[];
  inviteType?: ReferralInviteType;
}

export const useReferralModal = create<{
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}>(set => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set(state => ({ isOpen: !state.isOpen })),
}));

export const ReferralModal: React.FC<ReferralModalProps> = ({
  tags = [],
  inviteType = ReferralInviteType.referral,
}) => {
  const { isOpen, close: onClose } = useReferralModal();

  const submitUserInvitation = useSubmitUserInvitation();
  const submitReferral = useSubmitReferral();
  // Select by mode, not truthiness: inviteType is always a truthy enum string, so the old
  // `inviteType ? ...` ternary always picked submitReferral and the userInvitation branch was
  // dead. Equality makes the modal's dual-mode (referral vs userInvitation) real.
  // The /api/reg-invites/user-invite endpoint isn't implemented yet, so userInvitation mode is
  // wired but not yet served - no current caller passes it (all use referral).
  const userInvitation = inviteType === ReferralInviteType.referral ? submitReferral : submitUserInvitation;
  const { serverSettings } = useServerSettings();

  const currentUser = useUser(s => s.currentUser);
  const userId = currentUser?.id;
  const userName = currentUser?.name;

  const [friendEmail, setFriendEmail] = useState<string>('');
  const [numReferralsAvailable, setNumReferralsAvailable] = useState<number>(0);
  const { t } = useTranslation();
  const [loading, setLoading] = React.useState<boolean>(false);

  const [emailTitle, setEmailTitle] = useState<string>(t('referral.email_title_default'));
  const [emailBody, setEmailBody] = useState<string>(
    t('referral.email_body_default').replace('USER_NAME', currentUser?.name || '')
  );

  const referralCreditsAmount = useMemo(() => {
    return serverSettings.find(
      (setting: { settingName: string; settingValue: string }) => setting.settingName === 'ReferralCreditsAmount'
    );
  }, [serverSettings]);

  useEffect(() => {
    if (!currentUser) return;

    const fetchReferralInfo = async () => {
      setNumReferralsAvailable(currentUser.numReferralsAvailable || 0);
    };

    fetchReferralInfo();
  }, [currentUser, userId]);

  const handleClose = (event: {}, reason: 'backdropClick' | 'escapeKeyDown' | 'closeClick') => {
    setFriendEmail('');
    setEmailBody(t('referral.email_body_default').replace('USER_NAME', currentUser?.name || ''));
    if (reason === 'closeClick') onClose();
  };

  const handleReferralSubmit = async () => {
    if (!friendEmail.trim()) {
      console.error('Friend email is empty');
      return;
    }

    const emailArray = friendEmail.split(/[,; ]+/).filter(email => email.trim());

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    const validEmailArray = emailArray.filter(email => emailRegex.test(email));

    if (validEmailArray.length === 0) {
      console.error('No valid email addresses provided');
      toast.error(t('referral.no_valid_emails_error'));
      return;
    }

    if (validEmailArray.length === 0) {
      console.error('Friend email is empty');
      toast.error(t('referral.no_valid_emails_error'));
      return;
    }

    if (!userId || !userName) {
      console.error('User ID or name is not available');
      toast.error(t('referral.no_valid_emails_error'));
      return;
    }

    try {
      setLoading(true);
      userInvitation.mutate(
        {
          userName,
          friendEmail: validEmailArray,
          emailTitle,
          emailBody,
          tags,
        },
        {
          // Partial, not full IReferralResult: the referral endpoint returns the complete
          // per-email summary, but the (future) user-invitation endpoint does not. The
          // Array.isArray guards below treat every field as optional, so the type matches
          // the real runtime contract across both modes.
          onSuccess: (result: Partial<IReferralResult> | undefined) => {
            setLoading(false);

            // The referral endpoint returns a per-email breakdown so we can warn the
            // sender about invites that were skipped (duplicate account) or failed,
            // rather than reporting a blanket success. Fall back gracefully for the
            // user-invitation endpoint, which does not return this summary.
            const sent = Array.isArray(result?.sent) ? result.sent : validEmailArray;
            const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
            const failed = Array.isArray(result?.failed) ? result.failed : [];

            if (sent.length > 0) {
              toast.success(t('referral.send_referral_success', { count: sent.length }));
            }
            if (skipped.length > 0) {
              toast.warning(t('referral.send_referral_skipped', { count: skipped.length }));
            }
            if (failed.length > 0) {
              toast.error(t('referral.send_referral_failed', { count: failed.length }));
            }

            onClose();
            setFriendEmail('');
            setNumReferralsAvailable(numReferralsAvailable - sent.length);
          },
        }
      );
    } catch (error) {
      console.error('Failed to submit referral:', error);
      setLoading(false);
    }
    setFriendEmail('');
    setEmailBody(t('referral.email_body_default').replace('USER_NAME', currentUser?.name || ''));
  };

  return (
    <Modal open={isOpen} onClose={(_, reason) => reason === 'backdropClick' && onClose()}>
      <ModalDialog
        variant="outlined"
        size="sm"
        sx={theme => ({
          maxWidth: '680px',
          borderRadius: '8px',
          boxShadow: `0 4px 30px ${blackAlpha[0][50]}`,
          position: 'relative',
        })}
      >
        <IconButton
          variant="plain"
          color="neutral"
          onClick={() => handleClose({}, 'closeClick')}
          sx={{
            position: 'absolute',
            top: '12px',
            right: '12px',
          }}
        >
          <CloseIcon />
        </IconButton>

        <DialogContent sx={{ mt: 4, pb: 3, px: 2 }}>
          <Typography
            level="h3"
            sx={{
              mb: 2,
              textAlign: 'center',
              fontWeight: 600,
            }}
          >
            {inviteType === ReferralInviteType.referral
              ? `Refer a friend to ${t('app_name')}!`
              : `Invite a friend to ${t('app_name')}!`}
          </Typography>

          <Typography
            level="body-md"
            sx={{
              mb: 3,
              textAlign: 'center',
            }}
          >
            Enter the email of the person you want to refer to {t('app_name')}
            <br />
            Invited person gets <strong>{referralCreditsAmount?.settingValue} credits</strong>.
          </Typography>

          <Stack spacing={2.5} sx={{ mb: 3 }}>
            <FormControl>
              <FormLabel
                sx={{
                  mb: 0.5,
                }}
              >
                Friend&apos;s Email *
              </FormLabel>
              <Input
                value={friendEmail}
                autoFocus
                onChange={e => setFriendEmail(e.target.value)}
                sx={{
                  borderRadius: '4px',
                  '&:focus-within': {
                    borderColor: 'primary.500',
                  },
                }}
              />
            </FormControl>

            <FormControl>
              <FormLabel
                sx={{
                  mb: 0.5,
                }}
              >
                Email Topic
              </FormLabel>
              <Input
                value={emailTitle}
                onChange={e => setEmailTitle(e.target.value)}
                placeholder="Message"
                sx={{
                  borderRadius: '4px',
                  '&:focus-within': {
                    borderColor: 'primary.500',
                  },
                }}
              />
            </FormControl>

            <FormControl>
              <FormLabel
                sx={{
                  mb: 0.5,
                }}
              >
                Message
              </FormLabel>
              <Textarea
                value={emailBody}
                onChange={e => setEmailBody(e.target.value)}
                minRows={4}
                placeholder="Lorem ipsum dolor sit amet consectetur. Massa nisi mi arcu enim pellentesque tempus diam adipiscing. Tempus eu ac amet vestibulum odio vitae viverra. Sed turpis ullamcorper laoreet consequat egestas dignissim sed."
                sx={{
                  borderRadius: '4px',
                  '&:focus-within': {
                    borderColor: 'primary.500',
                  },
                }}
              />
            </FormControl>
          </Stack>

          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Typography
                level="body-sm"
                sx={{
                  mr: 1,
                }}
              >
                Referrals available:
              </Typography>
              <Typography
                level="body-sm"
                sx={{
                  color: green[600],
                  fontWeight: 'bold',
                }}
              >
                {numReferralsAvailable}
              </Typography>
            </Box>

            <Button
              disabled={!friendEmail || numReferralsAvailable === 0}
              onClick={handleReferralSubmit}
              sx={{
                backgroundColor: blue[775],
                borderRadius: '4px',
                px: 3,
                py: 1,
                '&:hover': {
                  backgroundColor: blue[750],
                },
              }}
            >
              {loading && <CircularProgress variant="plain" size="sm" sx={{ mr: 1 }} />}
              Invite a User
            </Button>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default ReferralModal;
