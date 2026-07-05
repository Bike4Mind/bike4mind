/**
 * Admin UI for managing an organization's GitHub webhook integration:
 * URL/secret display, secret reveal and rotation, event selection, enable toggle.
 */

import { FC, useState, useCallback } from 'react';
import {
  Card,
  Typography,
  Box,
  Button,
  Stack,
  Input,
  FormControl,
  FormLabel,
  FormHelperText,
  Chip,
  IconButton,
  Alert,
  Switch,
  Skeleton,
  Divider,
} from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ReplayIcon from '@mui/icons-material/Replay';
import GitHubIcon from '@mui/icons-material/GitHub';
import EditIcon from '@mui/icons-material/Edit';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import { IOrganizationDocument } from '@bike4mind/common';
import { useConfirmationModal } from '@client/app/hooks/useConfirmation';
import {
  useGetOrgWebhookConfig,
  useCreateOrgWebhookConfig,
  useUpdateOrgWebhookConfig,
  useDeleteOrgWebhookConfig,
  useRotateOrgWebhookSecret,
  useTestOrgWebhook,
  useReplayDLQ,
} from '@client/app/hooks/data/useOrgWebhooks';
import { toast } from 'sonner';

// Common GitHub webhook events
const GITHUB_EVENTS = [
  { value: 'push', label: 'Push', description: 'Commits pushed to a branch' },
  { value: 'pull_request', label: 'Pull Request', description: 'PR opened, closed, merged, etc.' },
  { value: 'issues', label: 'Issues', description: 'Issue created, closed, etc.' },
  { value: 'issue_comment', label: 'Issue Comments', description: 'Comments on issues/PRs' },
  { value: 'pull_request_review', label: 'PR Reviews', description: 'PR review submitted' },
  { value: 'release', label: 'Releases', description: 'Release created or published' },
  { value: 'workflow_run', label: 'Workflow Runs', description: 'GitHub Actions workflow events' },
  { value: 'deployment', label: 'Deployments', description: 'Deployment created or updated' },
];

interface OrgWebhookConfigProps {
  organization: IOrganizationDocument;
}

const OrgWebhookConfig: FC<OrgWebhookConfigProps> = ({ organization }) => {
  const setConfirmationModal = useConfirmationModal.setState;
  const [showSecret, setShowSecret] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [isEditingEvents, setIsEditingEvents] = useState(false);
  const [editedEvents, setEditedEvents] = useState<string[]>([]);

  // Data hooks
  const { data: config, isLoading, isError, error } = useGetOrgWebhookConfig(organization.id);
  const { data: revealedConfig, refetch: refetchSecret } = useGetOrgWebhookConfig(organization.id, {
    revealSecret: showSecret,
  });

  const createConfig = useCreateOrgWebhookConfig();
  const updateConfig = useUpdateOrgWebhookConfig();
  const deleteConfig = useDeleteOrgWebhookConfig();
  const rotateSecret = useRotateOrgWebhookSecret();
  const testWebhook = useTestOrgWebhook();
  const replayDLQ = useReplayDLQ();

  const handleCopy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied to clipboard`);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  }, []);

  const handleToggleSecret = useCallback(() => {
    if (!showSecret) {
      setConfirmationModal({
        open: true,
        type: 'warning',
        title: 'Reveal Webhook Secret',
        description:
          'The webhook secret will be visible on screen. Make sure no one else can see your screen. ' +
          'You should only need to see this when copying it to GitHub.',
        okLabel: 'Reveal Secret',
        onOk: async () => {
          setShowSecret(true);
          await refetchSecret();
        },
      });
    } else {
      setShowSecret(false);
    }
  }, [showSecret, setConfirmationModal, refetchSecret]);

  const handleRotateSecret = useCallback(() => {
    setConfirmationModal({
      open: true,
      type: 'warning',
      title: 'Rotate Webhook Secret',
      description:
        'This will generate a new webhook secret. You will need to update the secret in your GitHub webhook settings. ' +
        'The old secret will no longer work.',
      okLabel: 'Rotate Secret',
      onOk: async () => {
        await rotateSecret.mutateAsync(organization.id);
        setShowSecret(false);
      },
    });
  }, [organization.id, rotateSecret, setConfirmationModal]);

  const handleCreateConfig = useCallback(async () => {
    await createConfig.mutateAsync({
      orgId: organization.id,
      data: {
        repos: [],
        subscribedEvents: selectedEvents.length > 0 ? selectedEvents : GITHUB_EVENTS.map(e => e.value),
      },
    });
    setSelectedEvents([]);
  }, [organization.id, createConfig, selectedEvents]);

  const handleDeleteConfig = useCallback(() => {
    const subscriberWarning =
      config?.subscriberCount && config.subscriberCount > 0
        ? `\n\nWarning: ${config.subscriberCount} active subscriber(s) will be automatically unsubscribed.`
        : '';

    setConfirmationModal({
      open: true,
      type: 'danger',
      title: 'Delete Webhook Configuration',
      description:
        'This will delete the webhook configuration and unregister it from GitHub. ' +
        'This action cannot be undone.' +
        subscriberWarning,
      okLabel: config?.subscriberCount ? `Delete & Remove ${config.subscriberCount} Subscriber(s)` : 'Delete',
      onOk: async () => {
        await deleteConfig.mutateAsync(organization.id);
      },
    });
  }, [organization.id, deleteConfig, setConfirmationModal, config]);

  const handleToggleEnabled = useCallback(async () => {
    if (!config) return;
    await updateConfig.mutateAsync({
      orgId: organization.id,
      data: { enabled: !config.enabled },
    });
  }, [config, organization.id, updateConfig]);

  const handleTestWebhook = useCallback(async () => {
    await testWebhook.mutateAsync({ orgId: organization.id });
  }, [organization.id, testWebhook]);

  const handleReplayDLQ = useCallback(() => {
    setConfirmationModal({
      open: true,
      type: 'warning',
      title: 'Replay Failed Deliveries',
      description:
        'This will re-queue all failed webhook deliveries for this organization. ' +
        'The deliveries will be retried with exponential backoff. Continue?',
      okLabel: 'Replay All',
      onOk: async () => {
        await replayDLQ.mutateAsync({ orgId: organization.id, all: true });
      },
    });
  }, [organization.id, replayDLQ, setConfirmationModal]);

  // Event checkbox handler (for create form)
  const handleEventToggle = useCallback((event: string) => {
    setSelectedEvents(prev => (prev.includes(event) ? prev.filter(e => e !== event) : [...prev, event]));
  }, []);

  // Event edit handlers (for existing config)
  const handleStartEditEvents = useCallback(() => {
    if (config?.subscribedEvents) {
      setEditedEvents(config.subscribedEvents);
    }
    setIsEditingEvents(true);
  }, [config]);

  const handleCancelEditEvents = useCallback(() => {
    setIsEditingEvents(false);
    setEditedEvents([]);
  }, []);

  const handleSaveEvents = useCallback(async () => {
    if (editedEvents.length === 0) {
      toast.error('Please select at least one event');
      return;
    }
    await updateConfig.mutateAsync({
      orgId: organization.id,
      data: { subscribedEvents: editedEvents },
    });
    setIsEditingEvents(false);
    setEditedEvents([]);
    toast.success('Subscribed events updated');
  }, [editedEvents, organization.id, updateConfig]);

  const handleEditEventToggle = useCallback((event: string) => {
    setEditedEvents(prev => (prev.includes(event) ? prev.filter(e => e !== event) : [...prev, event]));
  }, []);

  // Loading state
  if (isLoading) {
    return (
      <Card variant="outlined">
        <Typography level="title-sm" sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <GitHubIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
          GitHub Webhook Integration
        </Typography>
        <Stack spacing={2} sx={{ p: 2 }}>
          <Skeleton variant="rectangular" height={40} />
          <Skeleton variant="rectangular" height={40} />
          <Skeleton variant="rectangular" height={100} />
        </Stack>
      </Card>
    );
  }

  // No config exists - show setup UI
  if (isError || !config) {
    const is404 = (error as { response?: { status: number } })?.response?.status === 404;

    if (!is404 && error) {
      return (
        <Card variant="outlined">
          <Typography level="title-sm" sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
            <GitHubIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
            GitHub Webhook Integration
          </Typography>
          <Box sx={{ p: 2 }}>
            <Alert color="danger">Failed to load webhook configuration. Please try again.</Alert>
          </Box>
        </Card>
      );
    }

    return (
      <Card variant="outlined">
        <Typography level="title-sm" sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <GitHubIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
          GitHub Webhook Integration
        </Typography>
        <Stack spacing={2} sx={{ p: 2 }}>
          <Alert color="neutral">
            Set up a GitHub webhook to receive repository events and share them with your team members. Team members can
            subscribe to receive events in their MCP servers.
          </Alert>

          <Typography level="title-sm">Select Events to Subscribe</Typography>
          <FormHelperText sx={{ mb: 1 }}>
            Click to select specific events, or leave all unselected to subscribe to all events.
          </FormHelperText>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {GITHUB_EVENTS.map(event => {
              // If nothing selected, show all as "soft" (will be selected)
              // If some selected, show selected as "solid", unselected as "outlined"
              const isSelected = selectedEvents.includes(event.value);
              const noneSelected = selectedEvents.length === 0;
              return (
                <Chip
                  key={event.value}
                  variant={isSelected ? 'solid' : noneSelected ? 'soft' : 'outlined'}
                  color={isSelected || noneSelected ? 'primary' : 'neutral'}
                  onClick={() => handleEventToggle(event.value)}
                  sx={{ cursor: 'pointer' }}
                >
                  {event.label}
                </Chip>
              );
            })}
          </Box>
          <Alert color="neutral" variant="soft" size="sm" sx={{ mt: 1 }}>
            {selectedEvents.length === 0
              ? 'All 8 events will be enabled (none specifically selected)'
              : `${selectedEvents.length} of ${GITHUB_EVENTS.length} event(s) selected`}
          </Alert>

          <Button
            color="primary"
            onClick={handleCreateConfig}
            loading={createConfig.isPending}
            startDecorator={<GitHubIcon />}
          >
            Create Webhook Configuration
          </Button>
        </Stack>
      </Card>
    );
  }

  // Config exists - show management UI
  const secretToShow = showSecret && revealedConfig?.secret ? revealedConfig.secret : config.secretMasked;

  return (
    <Card variant="outlined">
      <Typography level="title-sm" sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
        <GitHubIcon sx={{ mr: 1, verticalAlign: 'middle' }} />
        GitHub Webhook Integration
      </Typography>
      <Stack spacing={3} sx={{ p: 2 }}>
        {/* Status */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Chip variant="soft" color={config.enabled ? 'success' : 'neutral'} size="sm">
              {config.enabled ? 'Active' : 'Disabled'}
            </Chip>
            {config.subscriberCount !== undefined && (
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                {config.subscriberCount} subscriber{config.subscriberCount !== 1 ? 's' : ''}
              </Typography>
            )}
          </Box>
          <Switch checked={config.enabled} onChange={handleToggleEnabled} disabled={updateConfig.isPending} />
        </Box>

        <Divider />

        {/* Webhook URL */}
        <FormControl>
          <FormLabel>Webhook URL</FormLabel>
          <Input
            readOnly
            value={config.webhookUrl || ''}
            endDecorator={
              <IconButton
                variant="plain"
                onClick={() => handleCopy(config.webhookUrl || '', 'Webhook URL')}
                data-testid="copy-webhook-url"
              >
                <ContentCopyIcon />
              </IconButton>
            }
          />
          <FormHelperText>Copy this URL to your GitHub repository or organization webhook settings.</FormHelperText>
        </FormControl>

        {/* Secret */}
        <FormControl>
          <FormLabel>Webhook Secret</FormLabel>
          <Input
            readOnly
            type={showSecret ? 'text' : 'password'}
            value={secretToShow || ''}
            endDecorator={
              <Box sx={{ display: 'flex', gap: 0.5 }}>
                <IconButton variant="plain" onClick={handleToggleSecret} data-testid="toggle-secret-visibility">
                  {showSecret ? <VisibilityOffIcon /> : <VisibilityIcon />}
                </IconButton>
                {showSecret && (
                  <IconButton
                    variant="plain"
                    onClick={() => handleCopy(secretToShow || '', 'Secret')}
                    data-testid="copy-secret"
                  >
                    <ContentCopyIcon />
                  </IconButton>
                )}
                <IconButton
                  variant="plain"
                  onClick={handleRotateSecret}
                  disabled={rotateSecret.isPending}
                  data-testid="rotate-secret"
                >
                  <RefreshIcon />
                </IconButton>
              </Box>
            }
          />
          <FormHelperText>Use this secret in GitHub to sign webhook payloads for verification.</FormHelperText>
        </FormControl>

        <Divider />

        {/* Event Types */}
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography level="title-sm">Subscribed Events</Typography>
            {!isEditingEvents ? (
              <IconButton variant="plain" size="sm" onClick={handleStartEditEvents} data-testid="edit-events-btn">
                <EditIcon fontSize="small" />
              </IconButton>
            ) : (
              <Box sx={{ display: 'flex', gap: 0.5 }}>
                <IconButton
                  variant="soft"
                  color="success"
                  size="sm"
                  onClick={handleSaveEvents}
                  disabled={updateConfig.isPending}
                  data-testid="save-events-btn"
                >
                  <CheckIcon fontSize="small" />
                </IconButton>
                <IconButton
                  variant="soft"
                  color="neutral"
                  size="sm"
                  onClick={handleCancelEditEvents}
                  data-testid="cancel-edit-events-btn"
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Box>
            )}
          </Box>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {isEditingEvents ? (
              // Edit mode - show all events as toggleable chips
              GITHUB_EVENTS.map(event => (
                <Chip
                  key={event.value}
                  variant={editedEvents.includes(event.value) ? 'solid' : 'outlined'}
                  color={editedEvents.includes(event.value) ? 'primary' : 'neutral'}
                  size="sm"
                  onClick={() => handleEditEventToggle(event.value)}
                  sx={{ cursor: 'pointer' }}
                >
                  {event.label}
                </Chip>
              ))
            ) : config.subscribedEvents && config.subscribedEvents.length > 0 ? (
              // View mode - show only subscribed events
              config.subscribedEvents.map(event => (
                <Chip key={event} variant="soft" color="primary" size="sm">
                  {GITHUB_EVENTS.find(e => e.value === event)?.label || event}
                </Chip>
              ))
            ) : (
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                All events enabled
              </Typography>
            )}
          </Box>
          {isEditingEvents && (
            <FormHelperText sx={{ mt: 1 }}>
              Click events to toggle. {editedEvents.length} event(s) selected.
            </FormHelperText>
          )}
        </Box>

        <Divider />

        {/* Actions */}
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            color="neutral"
            onClick={handleTestWebhook}
            loading={testWebhook.isPending}
            startDecorator={<PlayArrowIcon />}
            data-testid="test-webhook"
          >
            Send Test Ping
          </Button>
          <Button
            variant="outlined"
            color="warning"
            onClick={handleReplayDLQ}
            loading={replayDLQ.isPending}
            startDecorator={<ReplayIcon />}
            data-testid="replay-failed-deliveries"
          >
            Replay Failed Deliveries
          </Button>
          <Button
            variant="outlined"
            color="danger"
            onClick={handleDeleteConfig}
            loading={deleteConfig.isPending}
            data-testid="delete-webhook-config"
          >
            Delete Configuration
          </Button>
        </Stack>

        {/* Last delivery info */}
        {config.lastDeliveryAt && (
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            Last delivery: {new Date(config.lastDeliveryAt).toLocaleString()}
          </Typography>
        )}
      </Stack>
    </Card>
  );
};

export default OrgWebhookConfig;
