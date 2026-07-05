import { Button, DialogActions, DialogContent, DialogTitle, Modal, ModalDialog, Typography } from '@mui/joy';
import EmailIcon from '@mui/icons-material/Email';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { useState, useEffect, useCallback } from 'react';

const RESEND_COOLDOWN_SECONDS = 60;

interface EmailVerificationModalProps {
  open: boolean;
  onClose: () => void;
  userEmail: string;
  onResendEmail?: () => void;
  isResending?: boolean;
}

/**
 * Modal shown after registration to prompt email verification.
 * More prominent than the banner so new users don't miss the step.
 */
const EmailVerificationModal: React.FC<EmailVerificationModalProps> = ({
  open,
  onClose,
  userEmail,
  onResendEmail,
  isResending = false,
}) => {
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  // Countdown timer for cooldown
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = setTimeout(() => setCooldownSeconds(s => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldownSeconds]);

  const handleResend = useCallback(() => {
    if (cooldownSeconds > 0 || !onResendEmail) return;
    onResendEmail();
    setCooldownSeconds(RESEND_COOLDOWN_SECONDS);
  }, [cooldownSeconds, onResendEmail]);

  const isDisabled = isResending || cooldownSeconds > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      data-testid="email-verification-modal"
      sx={{
        zIndex: 99999,
      }}
    >
      <ModalDialog sx={{ maxWidth: 500, zIndex: 99999 }}>
        <DialogTitle>
          <EmailIcon sx={{ mr: 1, color: 'primary.main' }} />
          <span data-testid="email-verification-title">Verify Your Email Address</span>
        </DialogTitle>
        <DialogContent>
          <Typography level="body-md" sx={{ mb: 2 }}>
            We&apos;ve sent a verification email to:
          </Typography>
          <Typography level="body-md" sx={{ fontWeight: 'bold', mb: 2, color: 'primary.main' }}>
            {userEmail}
          </Typography>
          <Typography level="body-sm" sx={{ mb: 2 }}>
            Please check your inbox and click the verification link to complete your registration. This helps us ensure
            you can recover your account if needed.
          </Typography>
          {onResendEmail && (
            <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
              <strong>Didn&apos;t receive the email?</strong> Check your spam folder, or use the button below to resend
              it.
            </Typography>
          )}
          {!onResendEmail && (
            <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
              <strong>Didn&apos;t receive the email?</strong> Check your spam folder.
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ flexDirection: 'column', gap: 1 }}>
          {onResendEmail && (
            <Button
              variant="outlined"
              color="neutral"
              onClick={handleResend}
              loading={isResending}
              disabled={isDisabled}
              startDecorator={isResending ? <CheckCircleIcon /> : <EmailIcon />}
              fullWidth
              data-testid="resend-verification-btn"
            >
              {isResending
                ? 'Email Sent!'
                : cooldownSeconds > 0
                  ? `Resend available in ${cooldownSeconds}s`
                  : 'Resend Verification Email'}
            </Button>
          )}
          <Button variant="solid" color="primary" onClick={onClose} fullWidth data-testid="modal-close-btn">
            Got It
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default EmailVerificationModal;
