import { Box, Button, Card, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import {
  isStoredPromptPossiblyTruncated,
  supportedVoiceGenerationVendor,
  VOICE_VENDOR_LABELS,
  type GeneratedAssetMetadata,
  type IFabFileDocument,
} from '@bike4mind/common';
import { useFileBrowser } from '@client/app/components/Files/fileBrowserStore';
import { MediaPlayer } from '@client/app/components/Media/MediaPlayer';
import { useAudioGenSettings, type AudioGenMode } from '@client/app/stores/useAudioGenSettings';
import { readGeneration, settingsFromGeneration } from './generatedAudioSettings';
import { useAudioStudioDraft } from './useAudioStudioDraft';

const providerLabel = (provider: string): string => {
  const vendor = supportedVoiceGenerationVendor.safeParse(provider);
  return vendor.success ? VOICE_VENDOR_LABELS[vendor.data] : provider;
};

const settingsSummary = (generation: GeneratedAssetMetadata): string => {
  const parts =
    generation.generator === 'speech'
      ? [providerLabel(generation.provider), generation.voice, generation.format, generation.languageCode]
      : [
          generation.durationSeconds ? `${generation.durationSeconds}s` : 'Auto length',
          generation.promptInfluence !== undefined && `Prompt influence ${generation.promptInfluence}`,
        ];
  return parts.filter(Boolean).join(', ');
};

type GeneratedAudioCardProps = {
  mode: AudioGenMode;
  file: IFabFileDocument;
};

/** One saved speech or sound-effect file in a Studio audio gallery. */
const GeneratedAudioCard = ({ mode, file }: GeneratedAudioCardProps) => {
  const openFiles = useFileBrowser(state => state.setOpen);
  const applySettings = useAudioGenSettings(state => state.applySettings);
  const setText = useAudioStudioDraft(state => state.setText);
  const generation = readGeneration(file);

  const reuseSettings = (reused: GeneratedAssetMetadata) => {
    applySettings(settingsFromGeneration(reused));
    // Saving keeps only a prefix of a long prompt, so restoring it would quietly send a script that
    // stops mid-sentence - and the user pays for the clip. Settings alone are still worth copying.
    const promptCut = isStoredPromptPossiblyTruncated(reused);
    if (!promptCut) setText(mode, reused.prompt);
    toast.success(
      promptCut
        ? 'Settings copied. The text was too long to keep, so paste it in again.'
        : 'Settings copied into the form above.'
    );
  };

  return (
    <Card variant="outlined" data-testid="generated-audio-card" data-file-id={file.id} sx={{ gap: 1 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Typography level="body-xs" data-testid="generated-audio-card-settings">
          {generation ? settingsSummary(generation) : file.fileName}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'text.tertiary', flexShrink: 0 }}>
          {new Date(file.createdAt).toLocaleString()}
        </Typography>
      </Stack>

      {generation && (
        <Typography
          level="body-sm"
          sx={{
            wordBreak: 'break-word',
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
          title={generation.prompt}
          data-testid="generated-audio-card-prompt"
        >
          {generation.prompt}
        </Typography>
      )}

      <Box data-testid="generated-audio-card-player">
        <MediaPlayer file={file} preload="metadata" />
      </Box>

      <Stack direction="row" gap={1} flexWrap="wrap">
        {generation && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={() => reuseSettings(generation)}
            data-testid="generated-audio-card-reuse-btn"
          >
            Use these settings
          </Button>
        )}
        <Button
          size="sm"
          variant="plain"
          onClick={() => openFiles(true)}
          data-testid="generated-audio-card-open-files-btn"
        >
          Open in Files
        </Button>
      </Stack>
    </Card>
  );
};

export default GeneratedAudioCard;
