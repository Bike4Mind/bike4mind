import React, { useState, useEffect, useRef } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { Box, Button, CircularProgress, Container, Link, Stack, Typography, Alert } from '@mui/joy';
import Image from 'next/image';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import useGetLogo from '../hooks/useGetLogo';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { useAccessToken } from '@client/app/hooks/useAccessToken';

interface IProps {
  token: string;
}

// Module-level Map to track verified tokens and their results across component remounts
const verifiedTokens = new Map<string, { success: boolean; error: string | null }>();

const VerifyEmailChange: React.FC<IProps> = ({ token }) => {
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<boolean>(true);
  const [success, setSuccess] = useState<boolean>(false);
  const { currentUser, setCurrentUser } = useUser();
  const setAccessToken = useAccessToken(s => s.setAccessToken);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logoUrl = useGetLogo();
  const hasStartedVerification = useRef(false);

  const isLoggedIn = !!currentUser;

  useEffect(() => {
    if (!token) {
      setError('No verification token provided.');
      setVerifying(false);
      return;
    }

    // Two guards: the ref prevents double execution within one instance; the Map prevents
    // re-execution across remounts and caches the result.
    if (hasStartedVerification.current) {
      return;
    }

    const cachedResult = verifiedTokens.get(token);
    if (cachedResult) {
      setSuccess(cachedResult.success);
      setError(cachedResult.error);
      setVerifying(false);
      return;
    }

    // Mark as started before any async work to close the double-fire race.
    hasStartedVerification.current = true;
    api
      .post('/api/email/verify-change', { token })
      .then(async response => {
        verifiedTokens.set(token, { success: true, error: null });
        setSuccess(true);
        setError(null);
        // Log out: email changed, so the user must re-login with the new address.
        if (isLoggedIn) {
          setAccessToken(null);
          setCurrentUser(null);
          // Clear cached queries so no stale user data survives the logout.
          queryClient.removeQueries();
        }
      })
      .catch((err: any) => {
        const errorMessage = err.response?.data?.error ?? err.message ?? 'Email verification failed';
        verifiedTokens.set(token, { success: false, error: errorMessage });
        setError(errorMessage);
        setSuccess(false);
      })
      .finally(() => {
        setVerifying(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]); // Only depend on token to prevent re-runs when user state changes

  const handleGoToLogin = () => {
    navigate({ to: '/login', replace: true });
  };

  const handleGoToSettings = () => {
    navigate({ to: '/profile', replace: true });
  };

  return (
    <Container
      className="verify-email-change-container"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        maxWidth: '90vw',
        mx: 'auto',
        pb: '20vh',
      }}
    >
      <Box
        className="verify-email-change-content"
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          margin: '1rem 0',
        }}
      >
        <Box className="verify-email-change-logo" sx={{ position: 'relative', width: 140, height: 100 }}>
          <Image
            src={logoUrl}
            alt="Logo"
            fill
            style={{
              objectFit: 'contain',
            }}
          />
        </Box>
        <Stack
          className="verify-email-change-stack"
          spacing={3}
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            width: '100%',
            maxWidth: '500px',
            mx: 'auto',
            mt: 4,
          }}
        >
          {verifying ? (
            <Box sx={{ textAlign: 'center' }}>
              <CircularProgress size="lg" />
              <Typography level="h4" sx={{ mt: 2 }}>
                Verifying your email change...
              </Typography>
            </Box>
          ) : success ? (
            <Alert
              color="success"
              variant="soft"
              sx={{
                width: '100%',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
              }}
            >
              <CheckCircleIcon sx={{ fontSize: 48, mb: 2 }} />
              <Stack spacing={2} sx={{ width: '100%', alignItems: 'center' }}>
                <Typography level="h4">Email Changed Successfully!</Typography>
                <Typography level="body-md">
                  Your email address has been changed. Please log in with your new email address.
                </Typography>
                <Button onClick={handleGoToLogin} color="success" sx={{ mt: 2 }}>
                  Continue to Login
                </Button>
              </Stack>
            </Alert>
          ) : (
            <Alert
              color="danger"
              variant="soft"
              sx={{
                width: '100%',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
              }}
            >
              <ErrorIcon sx={{ fontSize: 48, mb: 2 }} />
              <Stack spacing={2} sx={{ width: '100%', alignItems: 'center' }}>
                <Typography level="h4">Verification Failed</Typography>
                <Typography level="body-md">{error}</Typography>
                <Typography level="body-sm">
                  The email change link may have expired or is invalid.{' '}
                  {isLoggedIn ? (
                    <>You can request a new email change from your profile settings.</>
                  ) : (
                    <>
                      <Link href="/login">Log in</Link> to request a new email change.
                    </>
                  )}
                </Typography>
                {isLoggedIn ? (
                  <Button onClick={handleGoToSettings} color="neutral" sx={{ mt: 2 }}>
                    Go to Profile Settings
                  </Button>
                ) : (
                  <Button onClick={handleGoToLogin} color="neutral" sx={{ mt: 2 }}>
                    Go to Login
                  </Button>
                )}
              </Stack>
            </Alert>
          )}
        </Stack>
      </Box>
    </Container>
  );
};

export default VerifyEmailChange;
