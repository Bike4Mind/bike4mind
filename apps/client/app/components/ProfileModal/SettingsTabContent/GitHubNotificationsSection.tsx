import React, { useState, useEffect, useRef } from 'react';
import { Typography, Button, Input, Stack, FormControl, FormLabel, Box, Grid, Checkbox, Alert } from '@mui/joy';
import GitHubIcon from '@mui/icons-material/GitHub';
import { useUser } from '@client/app/contexts/UserContext';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { IUser } from '@bike4mind/common';

interface GitHubNotificationsSectionProps {
  githubLogin?: string;
  isSlackLinked: boolean;
}

type SlackSettings = NonNullable<IUser['slackSettings']>;
type GitHubNotifications = NonNullable<SlackSettings['githubNotifications']>;

const EVENT_TYPES = [
  { key: 'prOpened', label: 'PR Opened', description: 'New pull requests' },
  { key: 'prReviewRequested', label: 'Review Requested', description: 'When your review is requested' },
  { key: 'prApproved', label: 'PR Approved', description: 'Your PRs get approved' },
  { key: 'prChangesRequested', label: 'Changes Requested', description: 'Reviewers request changes' },
  { key: 'prMerged', label: 'PR Merged', description: 'Your PRs get merged' },
  { key: 'ciFailed', label: 'CI Failed', description: 'Your workflow runs fail' },
  { key: 'ciPassed', label: 'CI Passed', description: 'Your workflow runs pass' },
  { key: 'mentions', label: '@Mentions', description: 'Someone mentions you in a comment' },
] as const;

const GitHubNotificationsSection = ({ githubLogin, isSlackLinked }: GitHubNotificationsSectionProps) => {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();

  const slackSettings = currentUser?.slackSettings as SlackSettings | undefined;
  const hasLoaded = slackSettings !== undefined;
  const ghPrefs = slackSettings?.githubNotifications;
  const isEnabled = ghPrefs?.enabled ?? false;
  const isDirty = useRef(false);

  const [githubUsername, setGithubUsername] = useState(ghPrefs?.githubUsername ?? githubLogin ?? '');
  const [eventPrefs, setEventPrefs] = useState<Record<string, boolean>>({
    prOpened: ghPrefs?.prOpened ?? true,
    prReviewRequested: ghPrefs?.prReviewRequested ?? true,
    prApproved: ghPrefs?.prApproved ?? true,
    prChangesRequested: ghPrefs?.prChangesRequested ?? true,
    prMerged: ghPrefs?.prMerged ?? true,
    ciFailed: ghPrefs?.ciFailed ?? true,
    ciPassed: ghPrefs?.ciPassed ?? false,
    mentions: ghPrefs?.mentions ?? true,
  });
  const [defaultChannel, setDefaultChannel] = useState(ghPrefs?.channels?.default ?? '');
  const [ciAlertsChannel, setCiAlertsChannel] = useState(ghPrefs?.channels?.ciAlerts ?? '');

  // Auto-fill GitHub username from OAuth login if not already set
  useEffect(() => {
    if (githubLogin && !githubUsername && !ghPrefs?.githubUsername) {
      setGithubUsername(githubLogin);
    }
  }, [githubLogin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync state when server data updates (skip if user has unsaved local changes)
  useEffect(() => {
    const prefs = (currentUser?.slackSettings as SlackSettings | undefined)?.githubNotifications;
    if (prefs && !isDirty.current) {
      setGithubUsername(prefs.githubUsername ?? githubLogin ?? '');
      setEventPrefs({
        prOpened: prefs.prOpened ?? true,
        prReviewRequested: prefs.prReviewRequested ?? true,
        prApproved: prefs.prApproved ?? true,
        prChangesRequested: prefs.prChangesRequested ?? true,
        prMerged: prefs.prMerged ?? true,
        ciFailed: prefs.ciFailed ?? true,
        ciPassed: prefs.ciPassed ?? false,
        mentions: prefs.mentions ?? true,
      });
      setDefaultChannel(prefs.channels?.default ?? '');
      setCiAlertsChannel(prefs.channels?.ciAlerts ?? '');
    }
  }, [currentUser?.slackSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateSettings = useMutation({
    mutationFn: async (settings: Partial<SlackSettings>) => {
      const response = await api.patch(`/api/users/${currentUser?.id}/slack-settings`, settings);
      return response.data;
    },
    onSuccess: (_data, variables) => {
      isDirty.current = false;
      queryClient.invalidateQueries({ queryKey: ['user'] });
      const wasDisabled = variables.githubNotifications?.enabled === false;
      toast.success(wasDisabled ? 'GitHub notifications disabled' : 'GitHub notification settings saved');
    },
    onError: (error: unknown) => {
      console.error('Failed to save GitHub notification settings:', error);
      toast.error('Failed to save settings');
    },
  });

  const handleSave = () => {
    const ghNotifications: GitHubNotifications = {
      enabled: true,
      githubUsername: githubUsername || undefined,
      ...eventPrefs,
      channels: {
        default: defaultChannel || undefined,
        ciAlerts: ciAlertsChannel || undefined,
      },
    };

    const existingSettings = currentUser?.slackSettings as SlackSettings | undefined;
    updateSettings.mutate({
      ...existingSettings,
      githubNotifications: ghNotifications,
    });
  };

  const handleDisable = () => {
    const existingSettings = currentUser?.slackSettings as SlackSettings | undefined;
    updateSettings.mutate({
      ...existingSettings,
      githubNotifications: {
        ...existingSettings?.githubNotifications,
        enabled: false,
      },
    });
  };

  return (
    <Box
      sx={theme => ({
        mt: 3,
        p: 2,
        borderRadius: 'sm',
        backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : 'background.level1',
      })}
    >
      <Stack spacing={2}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <GitHubIcon sx={{ fontSize: 22, color: 'text.primary', opacity: 0.7 }} />
          <Typography level="body-sm" fontWeight="bold">
            GitHub Notifications
          </Typography>
          {isEnabled && (
            <Typography level="body-xs" sx={{ color: 'success.500', fontWeight: 'bold' }}>
              Active
            </Typography>
          )}
        </Box>

        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          Get Slack notifications for PRs, reviews, CI results, and @mentions
        </Typography>

        {!isSlackLinked && (
          <Alert color="warning" variant="soft" size="sm">
            <Typography level="body-sm">
              Link your Slack account first to receive notifications. Go to Slack Integration above.
            </Typography>
          </Alert>
        )}

        {isSlackLinked && (
          <>
            {/* GitHub Username */}
            <FormControl sx={{ maxWidth: 300 }}>
              <FormLabel sx={{ color: 'text.primary', opacity: 0.5 }}>GitHub Username</FormLabel>
              <Input
                placeholder="octocat"
                value={githubUsername}
                onChange={e => {
                  isDirty.current = true;
                  setGithubUsername(e.target.value);
                }}
                data-testid="github-username-input"
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
                Must match your GitHub login exactly (case-insensitive)
              </Typography>
            </FormControl>

            {/* Event Type Checkboxes */}
            <Box>
              <Typography level="body-sm" sx={{ mb: 1, color: 'text.primary', opacity: 0.6 }}>
                Choose which events trigger notifications:
              </Typography>
              <Grid container spacing={1}>
                {EVENT_TYPES.map(evt => (
                  <Grid xs={12} sm={6} key={evt.key}>
                    <Checkbox
                      checked={eventPrefs[evt.key] ?? true}
                      onChange={e => {
                        isDirty.current = true;
                        setEventPrefs(prev => ({ ...prev, [evt.key]: e.target.checked }));
                      }}
                      label={
                        <Box>
                          <Typography level="body-sm" component="span" sx={{ color: 'text.primary' }}>
                            {evt.label}
                          </Typography>{' '}
                          <Typography level="body-xs" component="span" sx={{ color: 'text.tertiary' }}>
                            {evt.description}
                          </Typography>
                        </Box>
                      }
                      data-testid={`github-notify-${evt.key}`}
                      sx={{ alignItems: 'flex-start' }}
                    />
                  </Grid>
                ))}
              </Grid>
            </Box>

            {/* Channel Routing */}
            <Box>
              <Typography level="body-sm" sx={{ mb: 1, color: 'text.primary', opacity: 0.6 }}>
                Channel routing (optional — leave empty for DMs):
              </Typography>
              <Grid container spacing={2}>
                <Grid xs={12} sm={6}>
                  <FormControl>
                    <FormLabel sx={{ color: 'text.primary', opacity: 0.5 }}>Default Channel ID</FormLabel>
                    <Input
                      placeholder="C0123456789"
                      value={defaultChannel}
                      onChange={e => {
                        isDirty.current = true;
                        setDefaultChannel(e.target.value);
                      }}
                      data-testid="github-default-channel-input"
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
                  </FormControl>
                </Grid>
                <Grid xs={12} sm={6}>
                  <FormControl>
                    <FormLabel sx={{ color: 'text.primary', opacity: 0.5 }}>CI Alerts Channel ID</FormLabel>
                    <Input
                      placeholder="C0123456789"
                      value={ciAlertsChannel}
                      onChange={e => {
                        isDirty.current = true;
                        setCiAlertsChannel(e.target.value);
                      }}
                      data-testid="github-ci-channel-input"
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
                  </FormControl>
                </Grid>
              </Grid>
            </Box>

            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                onClick={handleSave}
                loading={updateSettings.isPending}
                disabled={!hasLoaded || !githubUsername}
                data-testid="github-notifications-save"
              >
                {isEnabled ? 'Save Settings' : 'Enable Notifications'}
              </Button>
              {isEnabled && (
                <Button
                  variant="plain"
                  color="neutral"
                  onClick={handleDisable}
                  loading={updateSettings.isPending}
                  data-testid="github-notifications-disable"
                >
                  Disable
                </Button>
              )}
            </Box>
          </>
        )}
      </Stack>
    </Box>
  );
};

export default GitHubNotificationsSection;
