import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Box, Button, Card, Container, Typography, Stack } from '@mui/joy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';

interface ErrorInfo {
  title: string;
  message: string;
  canRetry: boolean;
}

const ERROR_MESSAGES: Record<string, ErrorInfo> = {
  invalid_params: {
    title: 'Invalid Request',
    message: 'The OAuth request was missing required parameters. Please try installing again.',
    canRetry: true,
  },
  access_denied: {
    title: 'Installation Cancelled',
    message: 'You cancelled the Slack app installation. No changes were made to your workspace.',
    canRetry: true,
  },
  invalid_code: {
    title: 'Invalid Authorization Code',
    message: 'The authorization code from Slack was invalid or expired. Please try again.',
    canRetry: true,
  },
  server_error: {
    title: 'Server Error',
    message: 'An unexpected error occurred on our server. Please try again.',
    canRetry: true,
  },
};

const DEFAULT_ERROR: ErrorInfo = {
  title: 'Installation Failed',
  message: 'Something went wrong during the installation process. Please try again.',
  canRetry: true,
};

const SlackErrorPage = () => {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });

  const [errorInfo, setErrorInfo] = useState<ErrorInfo>(DEFAULT_ERROR);
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => {
    const params = search as { reason?: string };
    const reason = params.reason;

    if (reason && ERROR_MESSAGES[reason]) {
      setErrorInfo(ERROR_MESSAGES[reason]);
    } else {
      setErrorInfo(DEFAULT_ERROR);
    }
  }, [search]);

  const handleTryAgain = () => {
    setIsRetrying(true);
    navigate({ to: '/integrations/slack/install' });
  };

  const handleGoHome = () => {
    navigate({ to: '/new' });
  };

  return (
    <Container
      maxWidth="md"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        justifyContent: 'center',
        alignItems: 'center',
        py: 4,
      }}
    >
      <Card
        variant="outlined"
        sx={{
          width: '100%',
          p: 4,
          boxShadow: 'md',
        }}
      >
        <Stack spacing={3} alignItems="center">
          {/* Error Icon */}
          <Box
            sx={{
              width: 80,
              height: 80,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              bgcolor: 'danger.softBg',
              mb: 1,
            }}
          >
            <ErrorOutlineIcon sx={{ fontSize: 48, color: 'danger.500' }} />
          </Box>

          {/* Title */}
          <Typography level="h2" textAlign="center">
            {errorInfo.title}
          </Typography>

          {/* Description */}
          <Typography level="body-md" textAlign="center" color="neutral" sx={{ maxWidth: 500 }}>
            {errorInfo.message}
          </Typography>

          {/* Troubleshooting Tips */}
          <Box sx={{ width: '100%', maxWidth: 500, mt: 2 }}>
            <Typography level="title-md" sx={{ mb: 2 }}>
              Troubleshooting:
            </Typography>
            <Stack spacing={1.5}>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                <Typography level="body-sm" color="neutral">
                  • Make sure you have admin permissions in your Slack workspace
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                <Typography level="body-sm" color="neutral">
                  • Check your internet connection and try again
                </Typography>
              </Box>
            </Stack>
          </Box>

          {/* Action Buttons */}
          <Stack direction="row" spacing={2} sx={{ mt: 3, flexWrap: 'wrap', justifyContent: 'center' }}>
            {errorInfo.canRetry && (
              <Button
                variant="solid"
                size="lg"
                onClick={handleTryAgain}
                loading={isRetrying}
                data-testid="slack-error-retry-btn"
                sx={{
                  px: 4,
                  py: 1.5,
                  fontSize: 'md',
                  fontWeight: 600,
                }}
              >
                Try Again
              </Button>
            )}
            <Button
              variant="outlined"
              size="lg"
              onClick={handleGoHome}
              data-testid="slack-error-dashboard-btn"
              sx={{
                px: 4,
                py: 1.5,
                fontSize: 'md',
                fontWeight: 600,
              }}
            >
              Go to Dashboard
            </Button>
          </Stack>
        </Stack>
      </Card>
    </Container>
  );
};

export default SlackErrorPage;
