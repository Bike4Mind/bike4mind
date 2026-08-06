import { Box, FormControl, FormLabel, Option, Select, Slider, Typography } from '@mui/joy';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import {
  AVAILABLE_TTS_VOICES,
  supportedVoiceGenerationVendor,
  VOICE_VENDOR_SUPPORTED_FORMATS,
  type VoiceGenerationVendor,
  type VoiceOutputFormat,
} from '@bike4mind/common';
import { useAudioGenSettings, type AudioGenMode } from '@client/app/stores/useAudioGenSettings';

const PROVIDER_LABELS: Record<VoiceGenerationVendor, string> = {
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
};

const PROVIDERS = supportedVoiceGenerationVendor.options;

// ElevenLabs sound-effect duration bounds mirror soundEffectsRequestSchema.
const SFX_MIN_DURATION = 0.5;
const SFX_MAX_DURATION = 30;

// Each mode gets its own surface in the standalone settings view so TTS and
// sound effects read as two distinct tools rather than one merged form.
const cardSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  p: 2,
  borderRadius: 'md',
  border: '1px solid',
  borderColor: 'divider',
  bgcolor: 'background.level1',
} as const;

const barePanelSx = { display: 'flex', flexDirection: 'column', gap: 2 } as const;

const SectionHeader: React.FC<{ icon: React.ReactNode; title: string; caption: string }> = ({
  icon,
  title,
  caption,
}) => (
  <Box>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      {icon}
      <Typography level="title-sm">{title}</Typography>
    </Box>
    <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 0.25 }}>
      {caption}
    </Typography>
  </Box>
);

/**
 * Shared audio-generation configuration controls, backed by useAudioGenSettings.
 * Reused by the AI Settings modal (as the settings home) and the in-app
 * GenerateAudioModal, so tweaks made in either surface persist to one store.
 *
 * `mode` scopes the visible controls to one generation mode; omit it to show
 * both. Without a mode (the settings-modal view) each mode is boxed into its own
 * labeled section; with a mode set the controls render bare, since the caller
 * (the generate dialog) already frames and labels the active mode.
 */
export const AudioGenerationSettings: React.FC<{ mode?: AudioGenMode }> = ({ mode }) => {
  const {
    ttsProvider,
    voice,
    format,
    languageCode,
    durationSeconds,
    promptInfluence,
    setTtsProvider,
    setVoice,
    setFormat,
    setLanguageCode,
    setDurationSeconds,
    setPromptInfluence,
  } = useAudioGenSettings();

  const supportedFormats = VOICE_VENDOR_SUPPORTED_FORMATS[ttsProvider];
  const showTts = mode !== 'sound-effects';
  const showSfx = mode !== 'tts';
  const sectioned = !mode;

  const handleProviderChange = (next: VoiceGenerationVendor) => {
    setTtsProvider(next);
    // Reset a now-unsupported format back to the universally-supported mp3.
    if (!VOICE_VENDOR_SUPPORTED_FORMATS[next].includes(format)) setFormat('mp3');
  };

  const ttsControls = (
    <>
      <FormControl size="sm">
        <FormLabel>Provider</FormLabel>
        <Select
          value={ttsProvider}
          onChange={(_, value) => value && handleProviderChange(value)}
          slotProps={{ button: { 'aria-label': 'TTS provider' } }}
          data-testid="audio-gen-provider-select"
        >
          {PROVIDERS.map(provider => (
            <Option key={provider} value={provider}>
              {PROVIDER_LABELS[provider]}
            </Option>
          ))}
        </Select>
      </FormControl>

      {ttsProvider === 'openai' ? (
        <FormControl size="sm">
          <FormLabel>Voice</FormLabel>
          <Select
            value={voice}
            onChange={(_, value) => setVoice(value ?? '')}
            placeholder="Use my preferred voice"
            data-testid="audio-gen-voice-select"
          >
            <Option value="">Use my preferred voice</Option>
            {AVAILABLE_TTS_VOICES.map(v => (
              <Option key={v.value} value={v.value}>
                {v.label}
              </Option>
            ))}
          </Select>
        </FormControl>
      ) : (
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          ElevenLabs uses the voice configured in your account settings.
        </Typography>
      )}

      <FormControl size="sm">
        <FormLabel>Format</FormLabel>
        <Select
          value={format}
          onChange={(_, value) => value && setFormat(value as VoiceOutputFormat)}
          data-testid="audio-gen-format-select"
        >
          {supportedFormats.map(f => (
            <Option key={f} value={f}>
              {f.toUpperCase()}
            </Option>
          ))}
        </Select>
      </FormControl>

      {ttsProvider === 'elevenlabs' && (
        <FormControl size="sm">
          <FormLabel>Language code</FormLabel>
          <Select
            value={languageCode}
            onChange={(_, value) => setLanguageCode(value ?? '')}
            placeholder="Auto-detect"
            data-testid="audio-gen-language-select"
          >
            <Option value="">Auto-detect</Option>
            <Option value="en">English (en)</Option>
            <Option value="ja">Japanese (ja)</Option>
            <Option value="es">Spanish (es)</Option>
            <Option value="fr">French (fr)</Option>
            <Option value="de">German (de)</Option>
          </Select>
        </FormControl>
      )}
    </>
  );

  const sfxControls = (
    <>
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        Powered by ElevenLabs.
      </Typography>
      <FormControl size="sm">
        <FormLabel>
          Duration: {durationSeconds == null ? `Auto (max ${SFX_MAX_DURATION}s)` : `${durationSeconds.toFixed(1)}s`}
        </FormLabel>
        <Slider
          value={durationSeconds ?? 0}
          min={0}
          max={SFX_MAX_DURATION}
          step={0.5}
          // 0 is the "let the provider auto-select" sentinel; anything below
          // the provider minimum is treated as auto.
          onChange={(_, value) => {
            const next = Array.isArray(value) ? value[0] : value;
            setDurationSeconds(next < SFX_MIN_DURATION ? null : next);
          }}
          valueLabelDisplay="auto"
          valueLabelFormat={v => (v < SFX_MIN_DURATION ? 'Auto' : `${v}s`)}
          data-testid="audio-gen-duration-slider"
        />
      </FormControl>

      <FormControl size="sm">
        <FormLabel>Prompt influence: {promptInfluence.toFixed(2)}</FormLabel>
        <Slider
          value={promptInfluence}
          min={0}
          max={1}
          step={0.05}
          onChange={(_, value) => setPromptInfluence(Array.isArray(value) ? value[0] : value)}
          valueLabelDisplay="auto"
          data-testid="audio-gen-influence-slider"
        />
      </FormControl>
    </>
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {showTts && (
        <Box sx={sectioned ? cardSx : barePanelSx} data-testid="audio-gen-tts-section">
          {sectioned && (
            <SectionHeader
              icon={<RecordVoiceOverIcon sx={{ fontSize: 18, color: 'primary.500' }} />}
              title="Text to speech"
              caption="Turn written text into spoken audio."
            />
          )}
          {ttsControls}
        </Box>
      )}

      {showSfx && (
        <Box sx={sectioned ? cardSx : barePanelSx} data-testid="audio-gen-sfx-section">
          {sectioned && (
            <SectionHeader
              icon={<GraphicEqIcon sx={{ fontSize: 18, color: 'primary.500' }} />}
              title="Sound effects"
              caption="Generate a sound from a text description."
            />
          )}
          {sfxControls}
        </Box>
      )}
    </Box>
  );
};

export default AudioGenerationSettings;
