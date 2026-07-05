import React, { useState, useEffect } from 'react';
import {
  Modal,
  ModalDialog,
  ModalClose,
  Typography,
  Box,
  Stack,
  FormControl,
  FormLabel,
  Input,
  Switch,
  Button,
  Textarea,
  Select,
  Option,
  Divider,
  CircularProgress,
} from '@mui/joy';
import { IAgent } from '@bike4mind/common';
import {
  useGetAgentProactiveConfig,
  useUpdateAgentProactiveConfig,
} from '@client/app/hooks/data/agentProactiveMessaging';
import { ISessionAgentConfigProactiveMessaging } from '@bike4mind/common';

interface AgentProactiveMessagingModalProps {
  open: boolean;
  onClose: () => void;
  agent: IAgent;
  sessionId: string;
}

// Get user's timezone as default
const getUserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};

const AgentProactiveMessagingModal: React.FC<AgentProactiveMessagingModalProps> = ({
  open,
  onClose,
  agent,
  sessionId,
}) => {
  const { data: existingConfig, isLoading } = useGetAgentProactiveConfig(sessionId, agent.id);
  const updateConfig = useUpdateAgentProactiveConfig();

  const [enabled, setEnabled] = useState(false);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(17);
  const [timezone, setTimezone] = useState(getUserTimezone());
  const [systemPrompt, setSystemPrompt] = useState('');
  const [minIntervalHours, setMinIntervalHours] = useState(24);

  // Load existing config when modal opens
  useEffect(() => {
    if (existingConfig) {
      setEnabled(existingConfig.proactiveMessaging.enabled);
      setStartHour(existingConfig.proactiveMessaging.activeHours.startHour);
      setEndHour(existingConfig.proactiveMessaging.activeHours.endHour);
      setTimezone(existingConfig.proactiveMessaging.activeHours.timezone || getUserTimezone());
      setSystemPrompt(existingConfig.proactiveMessaging.systemPrompt || '');
      setMinIntervalHours(existingConfig.proactiveMessaging.minIntervalHours || 24);
    } else if (!isLoading) {
      // Reset to defaults if no config exists
      setEnabled(false);
      setStartHour(9);
      setEndHour(17);
      setTimezone(getUserTimezone());
      setSystemPrompt('');
      setMinIntervalHours(24);
    }
  }, [existingConfig, isLoading]);

  const handleSave = async () => {
    // Validation
    if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
      return;
    }
    if (minIntervalHours < 1) {
      return;
    }

    const proactiveMessaging: ISessionAgentConfigProactiveMessaging = {
      enabled,
      activeHours: {
        startHour,
        endHour,
        timezone: timezone || undefined,
      },
      systemPrompt: systemPrompt.trim() || undefined,
      minIntervalHours: minIntervalHours || 24,
    };

    await updateConfig.mutateAsync({
      sessionId,
      agentId: agent.id,
      proactiveMessaging,
    });

    onClose();
  };

  const handleCancel = () => {
    // Reset to existing config values
    if (existingConfig) {
      setEnabled(existingConfig.proactiveMessaging.enabled);
      setStartHour(existingConfig.proactiveMessaging.activeHours.startHour);
      setEndHour(existingConfig.proactiveMessaging.activeHours.endHour);
      setTimezone(existingConfig.proactiveMessaging.activeHours.timezone || getUserTimezone());
      setSystemPrompt(existingConfig.proactiveMessaging.systemPrompt || '');
      setMinIntervalHours(existingConfig.proactiveMessaging.minIntervalHours || 24);
    }
    onClose();
  };

  // Generate hour options (0-23)
  const hourOptions = Array.from({ length: 24 }, (_, i) => i);

  return (
    <Modal
      open={open}
      onClose={handleCancel}
      sx={{
        zIndex: 1500, // Higher than Dropdown menu
      }}
    >
      <ModalDialog
        sx={{
          maxWidth: 600,
          width: '90%',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <ModalClose />
        <Box sx={{ p: 2 }}>
          {isLoading ? (
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                minHeight: 200,
              }}
            >
              <CircularProgress />
            </Box>
          ) : (
            <Stack spacing={3}>
              {/* Header */}
              <Box>
                <Typography level="h4" sx={{ mb: 0.5 }}>
                  Proactive Messaging Settings
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  Configure when and how {agent.name} should proactively message you
                </Typography>
              </Box>

              <Divider />

              {/* Enable Toggle */}
              <FormControl>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Box>
                    <FormLabel>Enable Proactive Messaging</FormLabel>
                    <Typography level="body-xs" sx={{ color: 'text.secondary', mt: 0.5 }}>
                      Allow {agent.name} to initiate conversations during specified hours
                    </Typography>
                  </Box>
                  <Switch checked={enabled} onChange={e => setEnabled(e.target.checked)} />
                </Box>
              </FormControl>

              {enabled && (
                <>
                  <Divider />

                  {/* Active Hours */}
                  <Box>
                    <FormLabel sx={{ mb: 1 }}>Active Hours</FormLabel>
                    <Stack direction="row" spacing={2} alignItems="center">
                      <FormControl sx={{ flex: 1 }}>
                        <FormLabel>Start Hour</FormLabel>
                        <Select
                          value={startHour}
                          onChange={(_, value) => value !== null && setStartHour(value)}
                          data-testid="proactive-messaging-start-hour"
                        >
                          {hourOptions.map(hour => (
                            <Option key={hour} value={hour}>
                              {hour.toString().padStart(2, '0')}:00
                            </Option>
                          ))}
                        </Select>
                      </FormControl>

                      <Typography level="body-md" sx={{ pt: 2 }}>
                        to
                      </Typography>

                      <FormControl sx={{ flex: 1 }}>
                        <FormLabel>End Hour</FormLabel>
                        <Select
                          value={endHour}
                          onChange={(_, value) => value !== null && setEndHour(value)}
                          data-testid="proactive-messaging-end-hour"
                        >
                          {hourOptions.map(hour => (
                            <Option key={hour} value={hour}>
                              {hour.toString().padStart(2, '0')}:00
                            </Option>
                          ))}
                        </Select>
                      </FormControl>
                    </Stack>
                    <Typography level="body-xs" sx={{ color: 'text.secondary', mt: 1 }}>
                      {endHour < startHour
                        ? `Overnight range: ${startHour.toString().padStart(2, '0')}:00 to ${endHour.toString().padStart(2, '0')}:00 next day (in your timezone)`
                        : `${startHour.toString().padStart(2, '0')}:00 to ${endHour.toString().padStart(2, '0')}:00 (in your timezone)`}
                    </Typography>
                  </Box>

                  {/* Minimum Interval */}
                  <FormControl>
                    <FormLabel>Minimum Interval Between Messages (hours)</FormLabel>
                    <Input
                      type="number"
                      value={minIntervalHours}
                      onChange={e => {
                        const value = parseInt(e.target.value, 10);
                        if (!isNaN(value) && value >= 1) {
                          setMinIntervalHours(value);
                        }
                      }}
                      slotProps={{
                        input: {
                          min: 1,
                        },
                      }}
                      data-testid="proactive-messaging-interval"
                    />
                    <Typography level="body-xs" sx={{ color: 'text.secondary', mt: 0.5 }}>
                      Minimum hours between proactive messages (prevents spam)
                    </Typography>
                  </FormControl>

                  {/* System Prompt */}
                  <FormControl>
                    <FormLabel>Custom System Prompt (Optional)</FormLabel>
                    <Textarea
                      value={systemPrompt}
                      onChange={e => setSystemPrompt(e.target.value)}
                      placeholder="How should the agent communicate when initiating messages? For example: 'Be concise and friendly. Focus on actionable insights.'"
                      minRows={4}
                      maxRows={8}
                      sx={{ fontFamily: 'monospace', fontSize: '0.875rem' }}
                      data-testid="proactive-messaging-prompt"
                    />
                    <Typography level="body-xs" sx={{ color: 'text.secondary', mt: 0.5 }}>
                      This prompt will be combined with the agent&apos;s base system prompt to guide proactive messages
                    </Typography>
                  </FormControl>
                </>
              )}

              <Divider />

              {/* Actions */}
              <Stack direction="row" spacing={2} justifyContent="flex-end">
                <Button
                  variant="outlined"
                  color="neutral"
                  onClick={handleCancel}
                  data-testid="proactive-messaging-cancel"
                >
                  Cancel
                </Button>
                <Button
                  variant="solid"
                  color="primary"
                  onClick={handleSave}
                  loading={updateConfig.isPending}
                  data-testid="proactive-messaging-save"
                >
                  Save
                </Button>
              </Stack>
            </Stack>
          )}
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default AgentProactiveMessagingModal;
