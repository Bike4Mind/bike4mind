import { FC, useEffect } from 'react';
import { Alert, Box, Button, Card, Chip, CircularProgress, Stack, Typography } from '@mui/joy';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import { IOrganizationDocument } from '@bike4mind/common';
import { useConfirmationModal } from '@client/app/hooks/useConfirmation';
import {
  useGetOrgSlackWorkspace,
  useConnectOrgSlack,
  useDisconnectOrgSlack,
} from '@client/app/hooks/data/useOrgSlackWorkspace';
import { useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';

interface OrgSlackIntegrationProps {
  organization: IOrganizationDocument;
}

const OrgSlackIntegration: FC<OrgSlackIntegrationProps> = ({ organization }) => {
  const confirm = useConfirmationModal.getState().confirm;
  const { data: workspace, isLoading, isError, refetch } = useGetOrgSlackWorkspace(organization.id);
  const connectMutation = useConnectOrgSlack();
  const disconnectMutation = useDisconnectOrgSlack();

  // Handle OAuth callback query params
  const search = useSearch({ strict: false }) as { slack_connected?: string; slack_error?: string };

  useEffect(() => {
    if (search.slack_connected === 'true') {
      toast.success('Slack workspace connected successfully!');
      refetch();
    } else if (search.slack_error) {
      const errorMessages: Record<string, string> = {
        access_denied: 'Slack authorization was denied.',
        invalid_state: 'Authorization expired. Please try again.',
        workspace_taken: 'This Slack workspace is already connected to another organization.',
        token_exchange_failed: 'Failed to connect. Please try again.',
        slack_unavailable: 'Slack is temporarily unavailable. Please try again later.',
        server_error: 'An unexpected error occurred. Please try again.',
      };
      toast.error(errorMessages[search.slack_error] || `Slack connection failed: ${search.slack_error}`);
    }
  }, [search.slack_connected, search.slack_error, refetch]);

  const handleConnect = async () => {
    const result = await connectMutation.mutateAsync(organization.id);
    if (!result.url) {
      toast.error('Failed to get Slack authorization URL. Please try again.');
      return;
    }
    window.location.href = result.url;
  };

  const handleDisconnect = () => {
    confirm({
      type: 'danger',
      title: 'Disconnect Slack Workspace',
      description:
        'Are you sure you want to disconnect this Slack workspace? Team members will no longer receive Slack notifications from this organization.',
      onOk: () => {
        disconnectMutation.mutate(organization.id);
      },
    });
  };

  if (isLoading) {
    return (
      <Card variant="outlined" sx={{ p: 3 }}>
        <Stack direction="row" alignItems="center" gap={2}>
          <CircularProgress size="sm" />
          <Typography>Loading Slack integration...</Typography>
        </Stack>
      </Card>
    );
  }

  // Error state - don't show connect button; it could confuse users during transient failures
  if (isError) {
    return (
      <Card variant="outlined" sx={{ p: 3 }}>
        <Stack spacing={2}>
          <Typography level="title-md">Slack Workspace</Typography>
          <Alert color="danger" variant="soft" size="sm">
            Failed to load Slack integration status. Please try again.
          </Alert>
          <Box>
            <Button data-testid="org-slack-retry-btn" variant="outlined" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </Box>
        </Stack>
      </Card>
    );
  }

  // Not connected state
  if (!workspace) {
    return (
      <Card variant="outlined" sx={{ p: 3 }}>
        <Stack spacing={2}>
          <Typography level="title-md">Slack Workspace</Typography>
          <Typography level="body-sm" color="neutral">
            Connect your Slack workspace to enable notifications and integrations for your team.
          </Typography>
          <Box>
            <Button
              data-testid="org-slack-connect-btn"
              startDecorator={<LinkIcon />}
              onClick={handleConnect}
              loading={connectMutation.isPending}
            >
              Connect Slack Workspace
            </Button>
          </Box>
        </Stack>
      </Card>
    );
  }

  // Connected state
  return (
    <Card variant="outlined" sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography level="title-md">Slack Workspace</Typography>
          <Chip
            size="sm"
            variant="soft"
            color={workspace.enabled ? 'success' : 'neutral'}
            startDecorator={workspace.enabled ? <CheckCircleOutlineIcon sx={{ fontSize: 14 }} /> : undefined}
          >
            {workspace.enabled ? 'Connected' : 'Disabled'}
          </Chip>
        </Stack>

        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between">
            <Typography level="body-sm" color="neutral">
              Workspace
            </Typography>
            <Typography level="body-sm">{workspace.slackTeamName || workspace.slackTeamId}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between">
            <Typography level="body-sm" color="neutral">
              Installed
            </Typography>
            <Typography level="body-sm">
              {workspace.installedAt ? new Date(workspace.installedAt).toLocaleDateString() : 'Unknown'}
            </Typography>
          </Stack>
        </Stack>

        {workspace.enabled && (
          <Alert color="success" variant="soft" size="sm">
            Your team can now link their personal Slack accounts via Settings to receive notifications.
          </Alert>
        )}

        <Box>
          <Button
            data-testid="org-slack-disconnect-btn"
            variant="outlined"
            color="danger"
            size="sm"
            startDecorator={<LinkOffIcon />}
            onClick={handleDisconnect}
            loading={disconnectMutation.isPending}
          >
            Disconnect
          </Button>
        </Box>
      </Stack>
    </Card>
  );
};

export default OrgSlackIntegration;
