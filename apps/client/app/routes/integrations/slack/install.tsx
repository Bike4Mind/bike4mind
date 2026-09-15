import { useState } from 'react';
import { Box, Button, Card, Container, Typography, Stack, Alert } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { ISlackDevWorkspaceDocument } from '@bike4mind/common';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { APP_NAME } from '@client/config/general';

const SlackInstallPage = () => {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = useSearch({ from: '/integrations/slack/install' });
  const workspaceId = (search as { workspaceId?: string }).workspaceId;

  // Fetch workspace information
  const {
    data: workspace,
    isLoading: isLoadingWorkspace,
    error: workspaceError,
  } = useQuery<ISlackDevWorkspaceDocument>({
    queryKey: ['slack-workspace', workspaceId],
    queryFn: async () => {
      if (!workspaceId) {
        throw new Error('Workspace ID is required');
      }
      const response = await api.get<ISlackDevWorkspaceDocument>(`/api/slack/workspace/${workspaceId}`);
      return response.data;
    },
    enabled: !!workspaceId,
  });

  // Derive error message from query error or workspaceId validation
  const workspaceErrorMessage = !workspaceId
    ? 'Workspace ID is required. Please access this page from the admin panel.'
    : workspaceError
      ? workspaceError instanceof Error
        ? workspaceError.message
        : 'Failed to load workspace information.'
      : null;

  const handleInstallClick = async () => {
    if (!workspaceId) {
      setError('Workspace ID is required. Please access this page from the admin panel.');
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      // Call server-side API to get OAuth URL (keeps credentials server-side)
      const { data } = await api.get(`/api/slack/oauth/authorize`, { params: { workspaceId } });

      // Redirect to Slack OAuth
      window.location.href = data.authUrl;
    } catch (err) {
      console.error('Failed to initiate Slack OAuth', err);
      setError(err instanceof Error ? err.message : 'Failed to connect to Slack. Please try again.');
      setIsLoading(false);
    }
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
          {/* Slack Logo */}
          <Box
            sx={{
              width: 80,
              height: 80,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '16px',
              background: mode === 'dark' ? '#611f69' : '#4A154B',
              mb: 1,
            }}
          >
            <svg width="48" height="48" viewBox="0 0 54 54" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386"
                fill="#36C5F0"
              />
              <path
                d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387"
                fill="#2EB67D"
              />
              <path
                d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386"
                fill="#ECB22E"
              />
              <path
                d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.25m14.336 0v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.25a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387"
                fill="#E01E5A"
              />
            </svg>
          </Box>

          {/* Workspace Name */}
          {isLoadingWorkspace ? (
            <Typography level="body-md" textAlign="center" color="neutral">
              Loading workspace...
            </Typography>
          ) : workspace ? (
            <Typography level="h2" textAlign="center">
              Install {workspace.slackBotName} for Slack
            </Typography>
          ) : null}

          {/* Description - brand externalized */}
          <Typography level="body-md" textAlign="center" color="neutral" sx={{ maxWidth: 500 }}>
            Connect your Slack workspace{APP_NAME ? ` to ${APP_NAME}` : ''} to enable seamless collaboration and
            intelligent assistance directly in your channels.
          </Typography>

          {/* Features */}
          <Stack spacing={2} sx={{ width: '100%', maxWidth: 500, mt: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
              <Typography level="title-lg">✓</Typography>
              <Box>
                <Typography level="title-md">Channel Integration</Typography>
                <Typography level="body-sm" color="neutral">
                  Interact with {APP_NAME || 'the bot'} directly in your Slack channels
                </Typography>
              </Box>
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
              <Typography level="title-lg">✓</Typography>
              <Box>
                <Typography level="title-md">AI Agents</Typography>
                <Typography level="body-sm" color="neutral">
                  Use @agent, @pm, @dev, and more to create tickets, summarize threads, and analyze conversations
                </Typography>
              </Box>
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
              <Typography level="title-lg">✓</Typography>
              <Box>
                <Typography level="title-md">Thread Support</Typography>
                <Typography level="body-sm" color="neutral">
                  Keep conversations organized with threaded responses
                </Typography>
              </Box>
            </Box>
          </Stack>

          {/* Installation Note Alert */}
          <Alert
            color="neutral"
            variant="soft"
            startDecorator={<InfoOutlinedIcon />}
            sx={{ width: '100%', maxWidth: 500, mt: 3 }}
          >
            <Box>
              <Typography level="title-sm" sx={{ mb: 1 }}>
                Installation Note
              </Typography>
              <Typography level="body-sm">
                When you click &ldquo;Add to Slack&rdquo;, Slack will show a warning that this app is &ldquo;not
                approved by Slack&rdquo;. This is normal for all private/internal apps not listed in Slack&apos;s public
                Marketplace.
              </Typography>
              <Typography level="body-sm" sx={{ mt: 1 }}>
                <strong>It&apos;s safe to click &ldquo;Allow&rdquo;</strong> - this is your organization&apos;s trusted
                {APP_NAME ? ` ${APP_NAME}` : ''} bot.
              </Typography>
              <Typography level="body-sm" sx={{ mt: 1 }}>
                We recommend having a Workspace Admin perform this installation.
              </Typography>
            </Box>
          </Alert>

          {/* Error Message */}
          {(error || workspaceErrorMessage) && (
            <Typography level="body-sm" color="danger" textAlign="center">
              {error || workspaceErrorMessage}
            </Typography>
          )}

          {/* Install Button */}
          <Button
            size="lg"
            onClick={handleInstallClick}
            loading={isLoading}
            disabled={!workspaceId}
            data-testid="slack-install-btn"
            sx={{
              mt: 3,
              px: 4,
              py: 1.5,
              fontSize: 'md',
              fontWeight: 600,
            }}
          >
            Add to Slack
          </Button>

          {/* Privacy Note */}
          <Typography level="body-xs" color="neutral" textAlign="center" sx={{ maxWidth: 400, mt: 2 }}>
            By installing, you authorize {APP_NAME || 'this app'} to access your workspace. Review our privacy policy
            and terms of service for details.
          </Typography>
        </Stack>
      </Card>
    </Container>
  );
};

export default SlackInstallPage;
