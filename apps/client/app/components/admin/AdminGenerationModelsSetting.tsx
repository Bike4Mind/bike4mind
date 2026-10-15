import React, { useMemo } from 'react';
import { Box, Card, Chip, Divider, Stack, Switch, Typography } from '@mui/joy';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import MusicNoteIcon from '@mui/icons-material/MusicNote';
import VideocamIcon from '@mui/icons-material/Videocam';
import { toast } from 'sonner';
import {
  MUSIC_MODEL_CATALOG,
  MUSIC_MODEL_IDS,
  MusicGenerationSettingsSchema,
  VIDEO_MODEL_CATALOG,
  VIDEO_MODEL_IDS,
  VideoGenerationSettingsSchema,
  isMusicModelEnabled,
  isVideoModelEnabled,
  type MusicModelId,
  type VideoModelId,
} from '@bike4mind/common';
import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';

// Both settings share this shape: a per-model override of the catalog's defaultEnabled.
type GenerationModelSettings = { enabledModels: Record<string, boolean> };

type CatalogEntry = { displayName: string; provider: string; defaultEnabled: boolean; preview?: boolean };

// Ties each modality to its own model ids, setting key and schema so a section cannot mix them.
type ModalityTypes = {
  video: { id: VideoModelId; settingKey: 'videoGeneration'; schema: typeof VideoGenerationSettingsSchema };
  music: { id: MusicModelId; settingKey: 'musicGeneration'; schema: typeof MusicGenerationSettingsSchema };
};
type Modality = keyof ModalityTypes;

type GenerationModality<M extends Modality> = {
  modality: M;
  settingKey: ModalityTypes[M]['settingKey'];
  title: string;
  icon: React.ReactNode;
  ids: readonly ModalityTypes[M]['id'][];
  catalog: Record<ModalityTypes[M]['id'], CatalogEntry>;
  schema: ModalityTypes[M]['schema'];
  // Must be the same helper the server uses, so the switch shows what the server will accept.
  isEnabled: (id: ModalityTypes[M]['id'], settings: GenerationModelSettings) => boolean;
};

const VIDEO_MODALITY: GenerationModality<'video'> = {
  modality: 'video',
  settingKey: 'videoGeneration',
  title: 'Video',
  icon: <VideocamIcon sx={{ mr: 1, color: 'primary.plainColor' }} />,
  ids: VIDEO_MODEL_IDS,
  catalog: VIDEO_MODEL_CATALOG,
  schema: VideoGenerationSettingsSchema,
  isEnabled: isVideoModelEnabled,
};

const MUSIC_MODALITY: GenerationModality<'music'> = {
  modality: 'music',
  settingKey: 'musicGeneration',
  title: 'Music',
  icon: <MusicNoteIcon sx={{ mr: 1, color: 'primary.plainColor' }} />,
  ids: MUSIC_MODEL_IDS,
  catalog: MUSIC_MODEL_CATALOG,
  schema: MusicGenerationSettingsSchema,
  isEnabled: isMusicModelEnabled,
};

const EMPTY_SETTINGS: GenerationModelSettings = { enabledModels: {} };

function GenerationModelsSection<M extends Modality>({ section }: { section: GenerationModality<M> }) {
  const { modality, settingKey, title, icon, ids, catalog, schema, isEnabled } = section;
  // One mutation per section: a save in flight locks only its own switches, since each section owns its own key.
  const updateSettings = useUpdateSettings();
  const { getSettingObject, authedSettingsLoaded } = useAdminSettings();
  // getSettingObject does not validate; malformed stored data falls back to catalog defaults.
  const settings = useMemo(() => {
    const parsed = schema.safeParse(getSettingObject(settingKey, EMPTY_SETTINGS));
    return parsed.success ? parsed.data : EMPTY_SETTINGS;
  }, [getSettingObject, schema, settingKey]);

  const handleToggle = (id: ModalityTypes[M]['id'], enabled: boolean) => {
    updateSettings.mutate(
      { key: settingKey, value: { enabledModels: { ...settings.enabledModels, [id]: enabled } } },
      {
        onSuccess: () => {
          toast.success(`${catalog[id].displayName} ${enabled ? 'enabled' : 'disabled'}`);
        },
        onError: (error: Error) => {
          toast.error(`Failed to update ${modality} generation models: ${error.message}`);
        },
      }
    );
  };

  const testId = `admin-generation-models-${modality}`;
  return (
    <Box data-testid={`${testId}-section`}>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
        {icon}
        <Typography level="title-md">{title}</Typography>
      </Box>
      <Stack spacing={1.5}>
        {ids.map(id => {
          const { displayName, provider, defaultEnabled, preview } = catalog[id];
          const hasOverride = settings.enabledModels[id] !== undefined;
          return (
            <Box key={id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
              <Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography level="title-sm">{displayName}</Typography>
                  {preview && (
                    <Chip size="sm" variant="soft" color="warning" data-testid={`${testId}-${id}-preview-chip`}>
                      Preview
                    </Chip>
                  )}
                </Box>
                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                  {provider}
                </Typography>
                {defaultEnabled && !hasOverride && (
                  <Typography level="body-xs" data-testid={`${testId}-${id}-default-note`}>
                    Enabled by default
                  </Typography>
                )}
              </Box>
              <Switch
                checked={isEnabled(id, settings)}
                // Until the stored value loads, a toggle would save over every other override with defaults.
                disabled={!authedSettingsLoaded || updateSettings.isPending}
                onChange={event => handleToggle(id, event.target.checked)}
                slotProps={{ input: { 'aria-label': `Enable ${displayName}` } }}
                data-testid={`${testId}-${id}-switch`}
              />
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

export const AdminGenerationModelsSetting: React.FC = () => (
  <Card variant="outlined" sx={{ mb: 2, p: 3 }} data-testid="admin-generation-models-card">
    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
      <AutoAwesomeIcon sx={{ mr: 1, color: 'primary.plainColor' }} />
      <Typography level="h4">Generation Models</Typography>
    </Box>
    <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
      Enable or disable individual generation models. Models without an override use their built-in default.
    </Typography>
    <Stack spacing={2} divider={<Divider />}>
      <GenerationModelsSection section={VIDEO_MODALITY} />
      <GenerationModelsSection section={MUSIC_MODALITY} />
    </Stack>
  </Card>
);
