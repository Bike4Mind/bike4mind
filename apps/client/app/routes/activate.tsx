import { useSearch, useNavigate } from '@tanstack/react-router';
import { useUser } from '../contexts/UserContext';
import { useVerifyDevice } from '../hooks/data/device-auth';
import { useState, useEffect } from 'react';
import { Box, Button, Input, Typography, Alert, Card, CardContent, Divider, Stack, Sheet } from '@mui/joy';
import { CheckCircle, Security, Terminal, Warning, Info, ErrorOutline } from '@mui/icons-material';

export default function ActivatePage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const prefilledCode = (search as any).code as string | undefined;

  const { currentUser } = useUser();
  const verifyMutation = useVerifyDevice();

  // Format code with hyphen
  const formatCode = (code: string) => {
    const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned.length > 4) {
      return cleaned.slice(0, 4) + '-' + cleaned.slice(4, 8);
    }
    return cleaned;
  };

  const [userCode, setUserCode] = useState(formatCode(prefilledCode || ''));

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUserCode(formatCode(e.target.value));
  };

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!currentUser) {
      const returnUrl = `/activate${prefilledCode ? `?code=${prefilledCode}` : ''}`;
      navigate({ to: '/login', search: { redirectTo: returnUrl } });
    }
  }, [currentUser, prefilledCode, navigate]);

  // The code is valid but the account has not accepted the AUP/ToS. Route to the acceptance
  // interstitial with a return path back here so the user can finish authorizing. Normally the
  // route's beforeLoad guard catches this before the form renders (see router.tsx); this is the
  // backstop for when consent state hydrates only after the page is already open. See issue #369.
  const goToAcceptPolicies = () => {
    navigate({ to: '/accept-policies', search: { redirectTo: `/activate?code=${userCode.toUpperCase()}` } });
  };

  const handleApprove = () => {
    verifyMutation.mutate(
      { user_code: userCode.toUpperCase(), action: 'approve' },
      {
        onSuccess: () => {
          // Show success state for 2 seconds, then redirect
          setTimeout(() => navigate({ to: '/' }), 2000);
        },
        onError: error => {
          if (error.response?.data?.policyAcceptanceRequired) {
            goToAcceptPolicies();
          }
        },
      }
    );
  };

  const handleDeny = () => {
    verifyMutation.mutate(
      { user_code: userCode.toUpperCase(), action: 'deny' },
      {
        onSuccess: () => {
          navigate({ to: '/' });
        },
      }
    );
  };

  if (!currentUser) {
    return null; // Redirecting...
  }

  if (verifyMutation.isSuccess) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 3,
        }}
      >
        <Card
          variant="outlined"
          sx={{
            maxWidth: 500,
            width: '100%',
            boxShadow: 'lg',
          }}
        >
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <CheckCircle
              sx={{
                fontSize: 80,
                color: 'success.500',
                mb: 3,
              }}
            />
            <Typography level="h2" sx={{ mb: 2, fontWeight: 600 }}>
              Device Activated
            </Typography>
            <Typography level="body-lg" sx={{ color: 'text.secondary', mb: 1 }}>
              Your device has been successfully authorized.
            </Typography>
            <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
              You can close this window and return to your CLI.
            </Typography>
          </CardContent>
        </Card>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 3,
      }}
    >
      <Card
        variant="outlined"
        sx={{
          maxWidth: 540,
          width: '100%',
          boxShadow: 'lg',
        }}
      >
        <CardContent sx={{ p: 4 }}>
          {/* Header */}
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 3 }}>
            <Sheet
              sx={{
                width: 48,
                height: 48,
                borderRadius: 'md',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'primary.softBg',
              }}
            >
              <Security sx={{ fontSize: 28, color: 'primary.500' }} />
            </Sheet>
            <Box>
              <Typography level="h3" sx={{ fontWeight: 600 }}>
                Device Authorization
              </Typography>
              <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                Authenticate your B4M CLI
              </Typography>
            </Box>
          </Stack>

          <Divider sx={{ my: 3 }} />

          {/* User Info */}
          <Sheet
            variant="soft"
            sx={{
              p: 2,
              borderRadius: 'sm',
              mb: 3,
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
            }}
          >
            <Info sx={{ fontSize: 20, color: 'primary.500' }} />
            <Box>
              <Typography level="body-sm" sx={{ fontWeight: 600, mb: 0.5 }}>
                Signed in as {currentUser?.username || currentUser?.email}
              </Typography>
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                This device will be authorized under your account
              </Typography>
            </Box>
          </Sheet>

          {/* Code Input Section */}
          <Box sx={{ mb: 3 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
              <Terminal sx={{ fontSize: 18, color: 'text.secondary' }} />
              <Typography level="body-sm" fontWeight={600}>
                Enter authorization code
              </Typography>
            </Stack>
            <Typography level="body-xs" sx={{ color: 'text.tertiary', mb: 2 }}>
              Enter the 8-character code displayed in your CLI terminal
            </Typography>
            <Input
              value={userCode}
              onChange={handleCodeChange}
              placeholder="XXXX-XXXX"
              size="lg"
              sx={{
                fontFamily: 'monospace',
                fontSize: '1.5rem',
                textAlign: 'center',
                letterSpacing: '0.15em',
                fontWeight: 600,
              }}
              slotProps={{ input: { maxLength: 9 } }}
              autoFocus
            />
          </Box>

          {/* Error Alert */}
          {verifyMutation.isError && (
            <Alert color="danger" variant="soft" sx={{ mb: 3 }} startDecorator={<ErrorOutline />}>
              <Box>
                <Typography level="title-sm" sx={{ mb: 0.5 }}>
                  Authorization Failed
                </Typography>
                {verifyMutation.error.response?.data?.policyAcceptanceRequired ? (
                  <>
                    <Typography level="body-sm" sx={{ mb: 1 }}>
                      Your account needs to accept the Terms of Service and Acceptable Use Policy before you can
                      authorize a device.
                    </Typography>
                    <Button size="sm" variant="soft" color="danger" onClick={goToAcceptPolicies}>
                      Review and accept policies
                    </Button>
                  </>
                ) : (
                  <Typography level="body-sm">
                    {verifyMutation.error.response?.data?.error_description ||
                      verifyMutation.error.response?.data?.error ||
                      'Invalid code'}
                  </Typography>
                )}
              </Box>
            </Alert>
          )}

          {/* Security Warning */}
          <Alert color="warning" variant="soft" sx={{ mb: 3 }} startDecorator={<Warning />}>
            <Box>
              <Typography level="title-sm" sx={{ mb: 0.5 }}>
                Security Notice
              </Typography>
              <Typography level="body-sm">
                Only approve if you recognize this device and initiated the authorization request from your CLI.
              </Typography>
            </Box>
          </Alert>

          {/* Action Buttons */}
          <Stack direction="row" spacing={2}>
            <Button
              onClick={handleApprove}
              loading={verifyMutation.isPending}
              color="success"
              size="lg"
              fullWidth
              disabled={userCode.length !== 9}
              sx={{ fontWeight: 600 }}
            >
              Approve Device
            </Button>
            <Button
              onClick={handleDeny}
              loading={verifyMutation.isPending}
              variant="outlined"
              color="neutral"
              size="lg"
              fullWidth
              disabled={userCode.length !== 9}
            >
              Deny
            </Button>
          </Stack>

          {/* Footer Info */}
          <Typography
            level="body-xs"
            sx={{
              mt: 3,
              textAlign: 'center',
              color: 'text.tertiary',
            }}
          >
            This authorization will grant CLI access to your B4M account
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
}
