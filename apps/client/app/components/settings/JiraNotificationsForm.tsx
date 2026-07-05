/**
 * Jira Notifications Form
 *
 * Single flat form for configuring Jira -> Slack notifications,
 * following the same pattern as GitHubNotificationsSection.
 *
 * States:
 * - Not configured: Setup form with channel ID, filters -> "Enable Notifications"
 * - Configured: Pre-filled form with saved values -> "Save Settings" / "Disable"
 *
 * Event selection is handled in Jira Admin (Admin -> System -> Webhooks),
 * not in this form. We accept all events Jira sends and filter by
 * project/priority at the subscription level.
 */

import { FC, useState, useEffect, useRef, useCallback } from 'react';
import {
  Typography,
  Box,
  Button,
  Stack,
  FormControl,
  FormLabel,
  FormHelperText,
  Input,
  Grid,
  Alert,
  Chip,
  IconButton,
} from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { JiraPriorityLevel, COMMON_JIRA_WEBHOOK_EVENTS } from '@bike4mind/common';
import {
  useGetJiraWebhookConfig,
  useCreateJiraWebhookConfig,
  useUpdateJiraWebhookConfig,
  useDeleteJiraWebhookConfig,
  useGetJiraWebhookSubscriptions,
  useCreateJiraWebhookSubscription,
  useUpdateJiraWebhookSubscription,
} from '@client/app/hooks/data/useJiraWebhooks';
import { useConfirmationModal } from '@client/app/hooks/useConfirmation';
import { toast } from 'sonner';

const PRIORITY_OPTIONS: { key: JiraPriorityLevel; label: string }[] = [
  { key: 'Highest', label: 'Highest' },
  { key: 'High', label: 'High' },
  { key: 'Medium', label: 'Medium' },
  { key: 'Low', label: 'Low' },
  { key: 'Lowest', label: 'Lowest' },
];

const JiraNotificationsForm: FC = () => {
  const setConfirmationModal = useConfirmationModal.setState;
  const isDirty = useRef(false);
  const [showSecret, setShowSecret] = useState(false);

  // Data hooks
  const {
    data: config,
    isLoading: configLoading,
    isError: configError,
  } = useGetJiraWebhookConfig({ revealSecret: showSecret });
  const { data: subscriptions, isLoading: subsLoading } = useGetJiraWebhookSubscriptions();
  const createConfig = useCreateJiraWebhookConfig();
  const updateConfig = useUpdateJiraWebhookConfig();
  const deleteConfig = useDeleteJiraWebhookConfig();
  const createSubscription = useCreateJiraWebhookSubscription();
  const updateSubscription = useUpdateJiraWebhookSubscription();

  // Derived state (404 returns null from queryFn, so isError is only for real failures)
  const hasConfig = !!config;
  const isEnabled = hasConfig && config.enabled;
  const existingSub = subscriptions?.[0]; // First subscription (simplified single-sub model)
  const isLoading = configLoading || subsLoading;

  // Form state
  const [slackChannelId, setSlackChannelId] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [priorityPrefs, setPriorityPrefs] = useState<Record<string, boolean>>({});

  const initFromDefaults = useCallback(() => {
    setPriorityPrefs({});
    setSlackChannelId('');
    setProjectFilter('');
  }, []);

  // Sync form state from server data (skip if user has local edits)
  useEffect(() => {
    if (isDirty.current) return;

    if (hasConfig && config) {
      // Sync subscription fields
      if (existingSub) {
        if (existingSub.slackTarget.type === 'channel') {
          setSlackChannelId(existingSub.slackTarget.channelId);
        } else {
          setSlackChannelId('');
        }
        setProjectFilter(existingSub.projectFilter?.join(', ') ?? '');
        const priorities: Record<string, boolean> = {};
        for (const p of PRIORITY_OPTIONS) {
          priorities[p.key] = existingSub.priorityFilter?.includes(p.key) ?? false;
        }
        setPriorityPrefs(priorities);
      }
    } else if (!configLoading) {
      initFromDefaults();
    }
  }, [config, existingSub, configLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied to clipboard`);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  }, []);

  const getSelectedPriorities = (): JiraPriorityLevel[] => {
    return PRIORITY_OPTIONS.filter(p => priorityPrefs[p.key]).map(p => p.key);
  };

  const getParsedProjects = (): string[] => {
    return projectFilter
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  };

  // Build slackTarget from channel ID (channel if provided, DM fallback)
  const buildSlackTarget = () => {
    const trimmed = slackChannelId.trim();
    if (trimmed) {
      return { type: 'channel' as const, channelId: trimmed };
    }
    return { type: 'dm' as const };
  };

  // Enable: create config + subscription in one click
  const handleEnable = useCallback(async () => {
    try {
      // Step 1: Create config (events default to COMMON_JIRA_WEBHOOK_EVENTS)
      const newConfig = await createConfig.mutateAsync({ events: COMMON_JIRA_WEBHOOK_EVENTS });

      // Step 2: Create subscription (accepts all events - event selection is in Jira Admin)
      await createSubscription.mutateAsync({
        webhookConfigId: newConfig.id,
        slackTarget: buildSlackTarget(),
        projectFilter: getParsedProjects(),
        priorityFilter: getSelectedPriorities(),
        name: 'Slack notifications',
      });

      isDirty.current = false;
      toast.success('Jira notifications enabled');
    } catch {
      // Errors are handled by the mutation hooks (toast)
    }
  }, [slackChannelId, projectFilter, priorityPrefs, createConfig, createSubscription]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save: update subscription filters
  const handleSave = useCallback(async () => {
    try {
      if (existingSub) {
        await updateSubscription.mutateAsync({
          id: existingSub.id,
          data: {
            slackTarget: buildSlackTarget(),
            projectFilter: getParsedProjects(),
            priorityFilter: getSelectedPriorities(),
          },
        });
      }

      isDirty.current = false;
      toast.success('Jira notification settings saved');
    } catch {
      // Errors are handled by the mutation hooks (toast)
    }
  }, [slackChannelId, projectFilter, priorityPrefs, existingSub, updateSubscription]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDisable = useCallback(async () => {
    try {
      await updateConfig.mutateAsync({ enabled: false });
      toast.success('Jira notifications disabled');
    } catch {
      // Error handled by hook
    }
  }, [updateConfig]);

  // Delete (with confirmation)
  const handleDelete = useCallback(() => {
    setConfirmationModal({
      open: true,
      type: 'danger',
      title: 'Delete Jira Notification Configuration',
      description:
        'This will delete the webhook configuration and all subscriptions. ' + 'This action cannot be undone.',
      okLabel: 'Delete',
      onOk: async () => {
        await deleteConfig.mutateAsync();
      },
    });
  }, [deleteConfig, setConfirmationModal]);

  const isSaving =
    createConfig.isPending || createSubscription.isPending || updateConfig.isPending || updateSubscription.isPending;

  if (configError) {
    return <Alert color="danger">Failed to load Jira notification settings. Please try again.</Alert>;
  }

  return (
    <Stack spacing={2}>
      {/* Last delivery info */}
      {hasConfig && config.lastDeliveryAt && (
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          Last delivery: {new Date(config.lastDeliveryAt).toLocaleString()}
        </Typography>
      )}

      {/* Setup instructions - shown when config exists */}
      {hasConfig && (
        <Alert color="primary" variant="soft" size="sm">
          <Box>
            <Typography level="body-sm" sx={{ fontWeight: 'bold', mb: 0.5 }}>
              Manual Jira Setup Required
            </Typography>
            <Typography level="body-xs" component="div">
              1. Copy the <b>Webhook URL</b> and <b>Secret</b> below
              <br />
              2. In Jira, go to <b>Settings → System → Webhooks (under Advanced) → Create a webhook</b>
              <br />
              3. Paste the URL, enter the secret, and select which events to send
            </Typography>
          </Box>
        </Alert>
      )}

      {/* Webhook URL & Secret - prominent display when config exists */}
      {hasConfig && (
        <Stack spacing={1.5}>
          <FormControl size="sm">
            <FormLabel>Webhook URL</FormLabel>
            <Input
              readOnly
              size="sm"
              value={config.webhookUrl || ''}
              endDecorator={
                <IconButton
                  variant="plain"
                  size="sm"
                  onClick={() => handleCopy(config.webhookUrl || '', 'Webhook URL')}
                  data-testid="copy-jira-webhook-url"
                >
                  <ContentCopyIcon sx={{ fontSize: 16 }} />
                </IconButton>
              }
            />
          </FormControl>
          <FormControl size="sm">
            <FormLabel>Webhook Secret</FormLabel>
            <Input
              readOnly
              size="sm"
              type={showSecret ? 'text' : 'password'}
              value={showSecret ? config.secret || config.secretMasked || '' : config.secretMasked || '****'}
              endDecorator={
                <Box sx={{ display: 'flex', gap: 0.5 }}>
                  <IconButton
                    variant="plain"
                    size="sm"
                    onClick={() => setShowSecret(prev => !prev)}
                    data-testid="toggle-jira-secret-visibility"
                  >
                    {showSecret ? (
                      <VisibilityOffIcon sx={{ fontSize: 16 }} />
                    ) : (
                      <VisibilityIcon sx={{ fontSize: 16 }} />
                    )}
                  </IconButton>
                  <IconButton
                    variant="plain"
                    size="sm"
                    onClick={async () => {
                      if (config.secret) {
                        handleCopy(config.secret, 'Secret');
                      } else {
                        // Fetch with revealSecret to get the plain secret for copying
                        try {
                          const res = await import('@client/app/contexts/ApiContext').then(m =>
                            m.api.get('/api/webhooks/jira/config', { params: { revealSecret: 'true' } })
                          );
                          const secret = res.data?.secret;
                          if (secret) {
                            handleCopy(secret, 'Secret');
                          } else {
                            toast.error('Could not retrieve secret');
                          }
                        } catch {
                          toast.error('Failed to retrieve secret');
                        }
                      }
                    }}
                    data-testid="copy-jira-secret"
                  >
                    <ContentCopyIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Box>
              }
            />
          </FormControl>
        </Stack>
      )}

      {/* Initial state - just show Enable button */}
      {!hasConfig && (
        <Box>
          <Typography level="body-sm" sx={{ mb: 1.5, color: 'text.tertiary' }}>
            Enable notifications to start receiving Jira events in Slack.
          </Typography>
          <Button
            onClick={handleEnable}
            loading={isSaving}
            disabled={isLoading}
            data-testid="jira-notifications-enable"
          >
            Enable Notifications
          </Button>
        </Box>
      )}

      {/* Configured state - show all settings */}
      {hasConfig && (
        <>
          {/* Slack Channel ID */}
          <FormControl>
            <FormLabel sx={{ color: 'text.primary', opacity: 0.5 }}>Slack Channel ID</FormLabel>
            <Input
              placeholder="C0123456789"
              value={slackChannelId}
              onChange={e => {
                isDirty.current = true;
                setSlackChannelId(e.target.value);
              }}
              disabled={isLoading}
              data-testid="jira-slack-channel-id"
              sx={{
                backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                '& input': {
                  backgroundColor: 'transparent',
                  color: 'text.primary',
                  fontSize: '14px',
                  '&::placeholder': { color: 'text.primary', opacity: 0.5, fontSize: '14px' },
                },
              }}
            />
            <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
              Leave empty to receive DMs. Right-click a Slack channel → View channel details → copy Channel ID.
              <br />
              <b>Note:</b> The slack bot must be added to the channel for notifications to work.
            </Typography>
          </FormControl>

          {/* Filters */}
          <Box>
            <Typography level="body-sm" sx={{ mb: 1, color: 'text.primary', opacity: 0.6 }}>
              Filters (optional):
            </Typography>
            <Grid container spacing={2}>
              <Grid xs={12} sm={6}>
                <FormControl>
                  <FormLabel sx={{ color: 'text.primary', opacity: 0.5 }}>Project Keys</FormLabel>
                  <Input
                    placeholder="PROJ, ENG, OPS"
                    value={projectFilter}
                    onChange={e => {
                      isDirty.current = true;
                      setProjectFilter(e.target.value);
                    }}
                    disabled={isLoading}
                    data-testid="jira-project-filter"
                    sx={{
                      backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                      '& input': {
                        backgroundColor: 'transparent',
                        color: 'text.primary',
                        fontSize: '14px',
                        '&::placeholder': { color: 'text.primary', opacity: 0.5, fontSize: '14px' },
                      },
                    }}
                  />
                  <FormHelperText>Comma-separated. Leave empty for all projects.</FormHelperText>
                </FormControl>
              </Grid>
              <Grid xs={12} sm={6}>
                <Box>
                  <Typography level="body-xs" sx={{ mb: 0.5, color: 'text.primary', opacity: 0.5, fontWeight: 'bold' }}>
                    Priority
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 0.5 }}>
                    {PRIORITY_OPTIONS.map(p => (
                      <Chip
                        key={p.key}
                        variant={priorityPrefs[p.key] ? 'solid' : 'outlined'}
                        color={priorityPrefs[p.key] ? 'primary' : 'neutral'}
                        size="sm"
                        onClick={() => {
                          isDirty.current = true;
                          setPriorityPrefs(prev => ({ ...prev, [p.key]: !prev[p.key] }));
                        }}
                        sx={{ cursor: 'pointer' }}
                        data-testid={`jira-priority-${p.key}`}
                      >
                        {p.label}
                      </Chip>
                    ))}
                  </Box>
                  <FormHelperText>Leave unselected for all priorities.</FormHelperText>
                </Box>
              </Grid>
            </Grid>
          </Box>

          {/* Actions */}
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              onClick={
                isEnabled
                  ? handleSave
                  : async () => {
                      await updateConfig.mutateAsync({ enabled: true });
                      toast.success('Jira notifications enabled');
                    }
              }
              loading={isSaving}
              data-testid="jira-notifications-save"
            >
              {isEnabled ? 'Save Settings' : 'Enable Notifications'}
            </Button>
            {isEnabled && (
              <Button
                variant="plain"
                color="neutral"
                onClick={handleDisable}
                loading={updateConfig.isPending}
                data-testid="jira-notifications-disable"
              >
                Disable
              </Button>
            )}
            <Button
              variant="plain"
              color="danger"
              onClick={handleDelete}
              loading={deleteConfig.isPending}
              data-testid="jira-notifications-delete"
              sx={{ ml: 'auto' }}
            >
              Delete
            </Button>
          </Box>
        </>
      )}
    </Stack>
  );
};

export default JiraNotificationsForm;
