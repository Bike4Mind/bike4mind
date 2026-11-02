import { CircularProgress, IconButton, List, ListItem, ListItemButton, ListItemContent, Typography } from '@mui/joy';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import { AVAILABLE_TTS_VOICES, openAiVoiceSamplePath, type VoiceGenerationVendor } from '@bike4mind/common';
import type { ElevenLabsVoice } from '@client/app/hooks/data/elevenLabsVoices';
import { useElevenLabsTtsVoices } from '@client/app/hooks/data/ttsVoices';
import { useVoiceSamplePlayer } from './useVoiceSamplePlayer';

type VoiceRow = {
  /** '' is the "provider default" row: the user's preferred / account voice. */
  value: string;
  label: string;
  description?: string;
  /** URL of a pre-recorded sample clip. */
  sample?: string;
};

type VoiceSampleListProps = {
  provider: VoiceGenerationVendor;
  value: string;
  onChange: (voice: string) => void;
};

const VoiceRows = ({ rows, value, onChange }: { rows: VoiceRow[]; value: string; onChange: (v: string) => void }) => {
  const player = useVoiceSamplePlayer();

  return (
    <List
      size="sm"
      role="radiogroup"
      aria-label="Voice"
      sx={{ '--List-gap': '2px', maxHeight: 280, overflowY: 'auto', borderRadius: 'sm' }}
      data-testid="voice-sample-list"
    >
      {rows.map(row => {
        const isActive = player.activeId === row.value;
        const testId = row.value || 'default';
        return (
          <ListItem
            key={testId}
            endAction={
              row.sample && (
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  aria-label={isActive ? `Stop ${row.label} sample` : `Play ${row.label} sample`}
                  onClick={() => row.sample && void player.toggle(row.value, row.sample)}
                  data-testid={`voice-sample-play-${testId}-btn`}
                >
                  {isActive ? <StopIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
                </IconButton>
              )
            }
          >
            <ListItemButton
              role="radio"
              aria-checked={value === row.value}
              selected={value === row.value}
              onClick={() => onChange(row.value)}
              data-testid={`voice-sample-select-${testId}-btn`}
            >
              <ListItemContent>
                <Typography level="title-sm">{row.label}</Typography>
                {row.description && (
                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }} noWrap>
                    {row.description}
                  </Typography>
                )}
              </ListItemContent>
            </ListItemButton>
          </ListItem>
        );
      })}
    </List>
  );
};

const OPENAI_ROWS: VoiceRow[] = [
  { value: '', label: 'Use my preferred voice' },
  ...AVAILABLE_TTS_VOICES.map(voice => ({
    value: voice.value,
    label: voice.label,
    description: voice.description,
    sample: openAiVoiceSamplePath(voice.value),
  })),
];

const describeElevenLabsVoice = ({ labels }: ElevenLabsVoice) =>
  // ElevenLabs labels are snake_case ids ("middle_aged"), not display text.
  [labels.gender, labels.age, labels.accent, labels.description ?? labels.descriptive]
    .filter(Boolean)
    .map(label => label.replace(/_/g, ' '))
    .join(', ') || undefined;

const ElevenLabsVoiceRows = ({ value, onChange }: Omit<VoiceSampleListProps, 'provider'>) => {
  const { data: voices, isLoading, isError } = useElevenLabsTtsVoices();

  if (isLoading) return <CircularProgress size="sm" data-testid="voice-sample-list-loading" />;
  // Empty when no ElevenLabs key is configured; synthesis then uses the account voice.
  if (isError || !voices?.length) {
    return (
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        ElevenLabs uses the voice configured in your account settings.
      </Typography>
    );
  }

  const rows: VoiceRow[] = [
    { value: '', label: 'Use my account voice' },
    ...voices.map(voice => ({
      value: voice.id,
      label: voice.name,
      description: describeElevenLabsVoice(voice),
      sample: voice.previewUrl,
    })),
  ];
  return <VoiceRows rows={rows} value={value} onChange={onChange} />;
};

/**
 * Studio's voice picker: every voice the provider offers, each with a sample to audition before
 * picking it. Every sample is pre-recorded: OpenAI's ship in apps/client/public, ElevenLabs hosts its own.
 */
export const VoiceSampleList = ({ provider, value, onChange }: VoiceSampleListProps) =>
  provider === 'openai' ? (
    <VoiceRows rows={OPENAI_ROWS} value={value} onChange={onChange} />
  ) : (
    <ElevenLabsVoiceRows value={value} onChange={onChange} />
  );

export default VoiceSampleList;
