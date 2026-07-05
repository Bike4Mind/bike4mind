import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Box, Button, Card, Container, Typography, Stack } from '@mui/joy';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import { APP_NAME } from '@client/config/general';

const SlackSuccessPage = () => {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });

  const [workspaceName, setWorkspaceName] = useState<string>('');
  const [teamId, setTeamId] = useState<string>('');
  const [isReinstall, setIsReinstall] = useState(false);

  useEffect(() => {
    const params = search as { workspace?: string; reinstall?: boolean; teamId?: string };

    if (params.workspace) {
      setWorkspaceName(params.workspace);
    }

    if (params.teamId) {
      setTeamId(params.teamId);
    }

    if (params.reinstall) {
      setIsReinstall(true);
    }
  }, [search]);

  const handleGoToSlack = () => {
    // Deep-link to specific workspace if teamId is available
    if (teamId) {
      window.location.href = `https://app.slack.com/client/${teamId}`;
    } else {
      window.location.href = 'https://slack.com';
    }
  };

  const handleGoToDashboard = () => {
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
          {/* Success Icon */}
          <Box
            sx={{
              width: 80,
              height: 80,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              bgcolor: 'success.softBg',
              mb: 1,
            }}
          >
            <CheckCircleOutlineIcon sx={{ fontSize: 48, color: 'success.500' }} />
          </Box>

          {/* Title */}
          <Typography level="h2" textAlign="center">
            {isReinstall ? 'Successfully Reinstalled!' : 'Installation Complete!'}
          </Typography>

          {/* Description */}
          <Typography level="body-md" textAlign="center" color="neutral" sx={{ maxWidth: 500 }}>
            {/* brand externalized */}
            {isReinstall ? (
              <>
                {APP_NAME || 'The app'} has been successfully reinstalled to{' '}
                <Typography fontWeight="bold" component="span">
                  {workspaceName || 'your workspace'}
                </Typography>
                . Your bot token has been updated.
              </>
            ) : (
              <>
                {APP_NAME || 'The app'} has been successfully installed to{' '}
                <Typography fontWeight="bold" component="span">
                  {workspaceName || 'your workspace'}
                </Typography>
                . You can now use the bot in your Slack channels!
              </>
            )}
          </Typography>

          {/* Next Steps */}
          <Stack spacing={2} sx={{ width: '100%', maxWidth: 500, mt: 2 }}>
            <Box>
              <Typography level="title-md" sx={{ mb: 1 }}>
                Next Steps:
              </Typography>
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
              <Typography level="body-md" sx={{ minWidth: 24 }}>
                1.
              </Typography>
              <Typography level="body-md">
                Link your Slack account in your{APP_NAME ? ` ${APP_NAME}` : ''} profile settings to enable personalized
                features
              </Typography>
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
              <Typography level="body-md" sx={{ minWidth: 24 }}>
                2.
              </Typography>
              <Typography level="body-md">
                Mention the bot in any channel or send it a direct message to start a conversation
              </Typography>
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
              <Typography level="body-md" sx={{ minWidth: 24 }}>
                3.
              </Typography>
              <Typography level="body-md">
                Your conversations will be synced to your{APP_NAME ? ` ${APP_NAME}` : ''} notebooks automatically
              </Typography>
            </Box>
          </Stack>

          {/* Action Buttons */}
          <Stack direction="row" spacing={2} sx={{ mt: 3 }}>
            <Button
              variant="solid"
              size="lg"
              onClick={handleGoToSlack}
              data-testid="slack-success-open-slack-btn"
              sx={{
                px: 4,
                py: 1.5,
                fontSize: 'md',
                fontWeight: 600,
              }}
            >
              Open Slack
            </Button>
            <Button
              variant="outlined"
              size="lg"
              onClick={handleGoToDashboard}
              data-testid="slack-success-dashboard-btn"
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

export default SlackSuccessPage;
