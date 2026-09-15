import React, { useState, useEffect, useRef } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { Box, Button, CircularProgress, Container, Link, Stack, Typography, Alert } from '@mui/joy';
import Image from 'next/image';
import { useNavigate } from '@tanstack/react-router';
import { api } from '@client/app/contexts/ApiContext';
import useGetLogo from '../hooks/useGetLogo';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';

interface IProps {
  token: string;
}

const VerifyEmail: React.FC<IProps> = ({ token }) => {
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<boolean>(true);
  const [success, setSuccess] = useState<boolean>(false);
  const { currentUser, refreshUser } = useUser();
  const navigate = useNavigate();
  const logoUrl = useGetLogo();

  const isLoggedIn = !!currentUser;
  // Verification tokens are single-use. Firing the POST twice (from any effect re-run,
  // e.g. refreshUser() changing a context-derived dep) makes the second call find the token
  // already cleared and return 400, even though the first succeeded. Guard per-token.
  const verifiedTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('No verification token provided.');
      setVerifying(false);
      return;
    }

    if (verifiedTokenRef.current === token) return;
    verifiedTokenRef.current = token;

    api
      .post('/api/email/verify', { token })
      .then(async () => {
        setSuccess(true);
        setError(null);
        // Refresh user data to get updated emailVerified status. We deliberately omit
        // refreshUser/isLoggedIn from the effect deps (relying on the ref guard above),
        // because including them re-fires this effect after the verify mutates user state.
        if (isLoggedIn) {
          await refreshUser();
        }
      })
      .catch((err: any) => {
        const errorMessage = err.response?.data?.error ?? err.message ?? 'Email verification failed';
        setError(errorMessage);
        setSuccess(false);
      })
      .finally(() => {
        setVerifying(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- token is the only legitimate trigger; see ref-guard comment
  }, [token]);

  const handleGoHome = () => {
    if (isLoggedIn) {
      navigate({ to: '/', replace: true });
    } else {
      navigate({ to: '/login', replace: true });
    }
  };

  return (
    <Container
      className="verify-email-container"
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
        className="verify-email-content"
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          margin: '1rem 0',
        }}
      >
        <Box className="verify-email-logo" sx={{ position: 'relative', width: 140, height: 100 }}>
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
          className="verify-email-stack"
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
                Verifying your email...
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
                <Typography level="h4">Email Verified Successfully!</Typography>
                <Typography level="body-md">
                  Your email address has been verified. You can now access all features of your account.
                </Typography>
                <Button onClick={handleGoHome} color="success" sx={{ mt: 2 }}>
                  {isLoggedIn ? 'Go to Dashboard' : 'Go to Login'}
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
                  The verification link may have expired or is invalid. Please{' '}
                  {isLoggedIn ? (
                    <>request a new verification email from your account settings.</>
                  ) : (
                    <>
                      <Link href="/login">log in</Link> and request a new verification email.
                    </>
                  )}
                </Typography>
                <Button onClick={handleGoHome} color="neutral" sx={{ mt: 2 }}>
                  {isLoggedIn ? 'Go to Dashboard' : 'Go to Login'}
                </Button>
              </Stack>
            </Alert>
          )}
        </Stack>
      </Box>
    </Container>
  );
};

export default VerifyEmail;
