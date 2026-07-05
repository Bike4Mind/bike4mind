import React, { useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Typography from '@mui/joy/Typography';
import Snackbar from '@mui/joy/Snackbar';
import { Close } from '@mui/icons-material';
import { useMutation } from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useShallow } from 'zustand/react/shallow';
import { useUser } from '@client/app/contexts/UserContext';
import { api } from '@client/app/contexts/ApiContext';
import {
  shouldShowVerificationNag,
  EMAIL_VERIFICATION_DISMISSED_KEY,
  EMAIL_VERIFICATION_PERMANENT_DISMISS_KEY,
} from '@client/app/utils/onboarding';

const RESEND_COOLDOWN_SECONDS = 60;

// Exact-match first, then prefix-with-slash to avoid matching /verify-email-preferences etc.
const EXCLUDED_ROUTES = ['/login', '/register', '/verify-email', '/verify-change'];

function isPermanentlyDismissed(): boolean {
  try {
    return localStorage.getItem(EMAIL_VERIFICATION_PERMANENT_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function shouldBannerShow(
  email: string | null | undefined,
  emailVerified: boolean | null | undefined,
  pathname: string
): boolean {
  if (!email || emailVerified) return false;
  if (EXCLUDED_ROUTES.some(r => pathname === r || pathname.startsWith(r + '/'))) return false;
  if (isPermanentlyDismissed()) return false;
  try {
    return shouldShowVerificationNag(localStorage.getItem(EMAIL_VERIFICATION_DISMISSED_KEY));
  } catch {
    return true; // localStorage unavailable - show banner (naggy is OK)
  }
}

const EmailVerificationBanner: React.FC = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Scoped selector avoids re-renders from unrelated currentUser field updates.
  const { email, emailVerified } = useUser(
    useShallow(s => ({
      email: s.currentUser?.email,
      emailVerified: s.currentUser?.emailVerified,
    }))
  );

  // Compute visibility synchronously on first render so there is no false->true flash
  // when the Zustand store is already populated (warm context after SPA navigation).
  const [visible, setVisible] = useState(() => shouldBannerShow(email, emailVerified, pathname));
  const [isSent, setIsSent] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  // Re-evaluate visibility whenever the user or route changes.
  // useLocation() is reactive, so pathname updates on every navigation.
  useEffect(() => {
    setVisible(shouldBannerShow(email, emailVerified, pathname));
  }, [email, emailVerified, pathname]);

  // Countdown timer for resend cooldown
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = setTimeout(() => setCooldownSeconds(s => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldownSeconds]);

  // Auto-reset "Email Sent!" after 5 s with proper cleanup to avoid firing on unmount
  useEffect(() => {
    if (!isSent) return;
    const timer = setTimeout(() => setIsSent(false), 5000);
    return () => clearTimeout(timer);
  }, [isSent]);

  const resendVerification = useMutation({
    mutationFn: async () => {
      const response = await api.post('/api/email/resend-verification');
      return response.data;
    },
    onSuccess: () => {
      setIsSent(true);
      // Only start cooldown after a confirmed send, not on error, so a 429 or 503
      // doesn't lock the user out of retrying with a different action (e.g. change email).
      setCooldownSeconds(RESEND_COOLDOWN_SECONDS);
    },
    onError: (error: { response?: { status?: number; data?: { message?: string; isConfigError?: boolean } } }) => {
      if (error.response?.status === 429) {
        setErrorMessage(
          "You've reached the limit for resending verification emails. Please wait 15 minutes before trying again."
        );
      } else if (error.response?.status === 503 && error.response?.data?.isConfigError) {
        setErrorMessage(error.response.data.message ?? 'Email service is not configured.');
      } else if (error.response?.data?.message) {
        setErrorMessage(error.response.data.message);
      } else {
        setErrorMessage('Failed to send verification email. Please try again later.');
      }
    },
  });

  const handleRemindLater = () => {
    try {
      localStorage.setItem(EMAIL_VERIFICATION_DISMISSED_KEY, Date.now().toString());
    } catch {
      // Silently fail - banner reappears on next load (naggy is OK)
    }
    setVisible(false);
  };

  const handleDontShowAgain = () => {
    try {
      localStorage.setItem(EMAIL_VERIFICATION_PERMANENT_DISMISS_KEY, '1');
    } catch {
      // Silently fail
    }
    setVisible(false);
  };

  const handleResend = () => {
    if (cooldownSeconds > 0 || resendVerification.isPending) return;
    resendVerification.mutate();
  };

  if (!visible) return null;

  return (
    <>
      <Box
        data-testid="email-verification-banner"
        sx={{
          position: 'fixed',
          top: 0,
          // On desktop the sidenav is visible and fixed at left: 0 with drawer-level z-index.
          // Offset the banner so it only covers the main content area, keeping the sidenav logo unobscured.
          left: { xs: 0, md: 'var(--notebook-sidenav-width, 0px)' },
          right: 0,
          // Use the Joy UI modal token (1300) so the Snackbar error (at 10000) remains above,
          // and we avoid a collision with other 9999 elements (e.g. CookieConsentBanner).
          zIndex: 'var(--joy-zIndex-modal, 1300)',
          px: 2,
          py: 1,
          bgcolor: 'background.surface',
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flexWrap: 'wrap',
        }}
      >
        <Typography level="body-sm" sx={{ flex: 1, minWidth: 200 }}>
          Please verify your email <strong style={{ fontWeight: 600 }}>{email}</strong> to unlock all features.
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0, flexWrap: 'wrap' }}>
          <Button
            variant="solid"
            color="primary"
            size="sm"
            onClick={handleResend}
            loading={resendVerification.isPending}
            disabled={isSent || cooldownSeconds > 0}
            data-testid="email-verification-banner-resend-btn"
          >
            {isSent ? 'Email Sent!' : cooldownSeconds > 0 ? `Resend in ${cooldownSeconds}s` : 'Resend'}
          </Button>

          <Button
            variant="outlined"
            color="neutral"
            size="sm"
            onClick={() => navigate({ to: '/profile' })}
            data-testid="email-verification-banner-change-email-btn"
          >
            Change email
          </Button>

          <Button
            variant="plain"
            color="neutral"
            size="sm"
            onClick={handleDontShowAgain}
            data-testid="email-verification-banner-dont-show-btn"
          >
            Don&apos;t show again
          </Button>
        </Box>

        <IconButton
          variant="plain"
          color="neutral"
          size="sm"
          onClick={handleRemindLater}
          aria-label="Remind me later"
          data-testid="email-verification-banner-dismiss-btn"
        >
          <Close fontSize="small" />
        </IconButton>
      </Box>

      <Snackbar
        open={!!errorMessage}
        autoHideDuration={8000}
        onClose={() => setErrorMessage(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        color="danger"
        variant="solid"
        sx={{ mt: 8, zIndex: 'var(--joy-zIndex-tooltip, 1500)' }}
        data-testid="email-verification-banner-error"
      >
        {errorMessage}
      </Snackbar>
    </>
  );
};

export default EmailVerificationBanner;
