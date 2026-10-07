import React, { useMemo } from 'react';
import { Box, Card, Stack, Switch, Typography } from '@mui/joy';
import VideocamIcon from '@mui/icons-material/Videocam';
import { toast } from 'sonner';
import {
  VIDEO_MODEL_CATALOG,
  VIDEO_MODEL_IDS,
  isVideoModelEnabled,
  VideoGenerationSettingsSchema,
  type VideoModelId,
} from '@bike4mind/common';
import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';

export const AdminVideoModelsSetting: React.FC = () => {
  const updateSettings = useUpdateSettings();
  const { getSettingObject } = useAdminSettings();
  // getSettingObject does not validate; malformed stored data falls back to catalog defaults.
  const settings = useMemo(() => {
    const parsed = VideoGenerationSettingsSchema.safeParse(getSettingObject('videoGeneration', { enabledModels: {} }));
    return parsed.success ? parsed.data : { enabledModels: {} };
  }, [getSettingObject]);

  const handleToggle = (id: VideoModelId, enabled: boolean) => {
    updateSettings.mutate(
      { key: 'videoGeneration', value: { enabledModels: { ...settings.enabledModels, [id]: enabled } } },
      {
        onSuccess: () => {
          toast.success(`${VIDEO_MODEL_CATALOG[id].displayName} ${enabled ? 'enabled' : 'disabled'}`);
        },
        onError: (error: Error) => {
          toast.error(`Failed to update video generation models: ${error.message}`);
        },
      }
    );
  };

  return (
    <Card variant="outlined" sx={{ mb: 2, p: 3 }} data-testid="admin-video-models-card">
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <VideocamIcon sx={{ mr: 1, color: 'primary.plainColor' }} />
        <Typography level="h4">Video Generation Models</Typography>
      </Box>
      <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
        Enable or disable individual video generation models. Models without an override use their built-in default.
      </Typography>
      <Stack spacing={1.5}>
        {VIDEO_MODEL_IDS.map(id => {
          const { displayName, provider, defaultEnabled } = VIDEO_MODEL_CATALOG[id];
          const hasOverride = settings.enabledModels[id] !== undefined;
          return (
            <Box key={id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
              <Box>
                <Typography level="title-sm">{displayName}</Typography>
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  {provider}
                </Typography>
                {defaultEnabled && !hasOverride && (
                  <Typography level="body-xs" data-testid={`admin-video-models-${id}-default-note`}>
                    Enabled by default
                  </Typography>
                )}
              </Box>
              <Switch
                checked={isVideoModelEnabled(id, settings)}
                disabled={updateSettings.isPending}
                onChange={event => handleToggle(id, event.target.checked)}
                slotProps={{ input: { 'aria-label': `Enable ${displayName}` } }}
                data-testid={`admin-video-models-${id}-switch`}
              />
            </Box>
          );
        })}
      </Stack>
    </Card>
  );
};
