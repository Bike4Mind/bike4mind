import { useMemo } from 'react';
import { Box, Button, Card, Divider, Stack, Textarea, Typography } from '@mui/joy';
import {
  estimateSoundCreditCost,
  estimateTtsCreditCost,
  SOUND_EFFECTS_MAX_INPUT_CHARS,
  TTS_DEFAULT_MODEL,
  TTS_MAX_INPUT_CHARS,
} from '@bike4mind/common';
import { AudioGenerationSettings } from '@client/app/components/Session/AISettings/AudioGenerationSettings';
import StudioModelsGate from '@client/app/components/Studio/StudioModelsGate';
import { useAudioProviders } from '@client/app/hooks/data/audioProviders';
import { useAudioGenSettings, type AudioGenMode } from '@client/app/stores/useAudioGenSettings';
import { useAudioStudioDraft } from './useAudioStudioDraft';
import { useGenerateAudio } from './useGenerateAudio';

const PLACEHOLDER: Record<AudioGenMode, string> = {
  tts: 'Enter the text you want spoken aloud...',
  'sound-effects': 'Describe the sound effect (e.g. "gentle rain on a tin roof")...',
};

const useEstimatedCredits = (mode: AudioGenMode, characters: number): number => {
  const ttsProvider = useAudioGenSettings(state => state.ttsProvider);
  const durationSeconds = useAudioGenSettings(state => state.durationSeconds);
  return useMemo(
    () =>
      mode === 'sound-effects'
        ? estimateSoundCreditCost('elevenlabs', { durationSeconds: durationSeconds ?? undefined })
        : estimateTtsCreditCost(ttsProvider, TTS_DEFAULT_MODEL[ttsProvider], characters),
    [mode, ttsProvider, durationSeconds, characters]
  );
};

const AudioStudioForm = ({ mode, testId }: { mode: AudioGenMode; testId: string }) => {
  const text = useAudioStudioDraft(state => state.text[mode]);
  const setText = useAudioStudioDraft(state => state.setText);
  const ttsProvider = useAudioGenSettings(state => state.ttsProvider);
  const { generate, isGenerating, result } = useGenerateAudio(mode);
  const estimatedCredits = useEstimatedCredits(mode, text.length);

  const maxChars = mode === 'tts' ? TTS_MAX_INPUT_CHARS[ttsProvider] : SOUND_EFFECTS_MAX_INPUT_CHARS;
  const overLimit = text.length > maxChars;

  return (
    <Card variant="outlined" sx={{ gap: 2 }} data-testid={`${testId}-form`}>
      <Box>
        <Textarea
          value={text}
          onChange={event => setText(mode, event.target.value)}
          minRows={3}
          maxRows={10}
          placeholder={PLACEHOLDER[mode]}
          error={overLimit}
          disabled={isGenerating}
          data-testid={`${testId}-text-input`}
        />
        <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid={`${testId}-credit-estimate`}>
            ~{estimatedCredits} credit{estimatedCredits === 1 ? '' : 's'} estimated
          </Typography>
          <Typography level="body-xs" sx={{ color: overLimit ? 'danger.500' : 'text.tertiary' }}>
            {text.length} / {maxChars}
          </Typography>
        </Stack>
      </Box>

      <Divider />
      <AudioGenerationSettings mode={mode} />
      <Divider />

      <Button
        onClick={() => void generate(text)}
        loading={isGenerating}
        disabled={!text.trim() || overLimit}
        sx={{ alignSelf: 'flex-start' }}
        data-testid={`${testId}-submit-btn`}
      >
        Generate
      </Button>

      {/* A saved result shows up first in the gallery below; only one Files could not keep is played here. */}
      {result && !result.saved && (
        <Stack gap={1}>
          <Box
            component="audio"
            controls
            autoPlay
            src={result.url}
            sx={{ width: '100%' }}
            data-testid={`${testId}-player`}
          />
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            This audio was not saved to your Files, so it is gone once you leave this page.
          </Typography>
        </Stack>
      )}
    </Card>
  );
};

const NOUN: Record<AudioGenMode, string> = {
  tts: 'speech',
  'sound-effects': 'sound effect',
};

/** A Studio audio tab's form, shown once the user has a key for at least one of the mode's providers. */
const AudioStudioWorkspace = ({ mode, testId }: { mode: AudioGenMode; testId: string }) => {
  const providers = useAudioProviders();
  const usable = mode === 'tts' ? providers.data?.speech : providers.data?.soundEffects;
  return (
    <StudioModelsGate testId={testId} noun={NOUN[mode]} models={{ isPending: providers.isPending, data: usable }}>
      {() => <AudioStudioForm mode={mode} testId={testId} />}
    </StudioModelsGate>
  );
};

export const SpeechStudioWorkspace = ({ testId }: { testId: string }) => (
  <AudioStudioWorkspace mode="tts" testId={testId} />
);

export const SoundEffectsStudioWorkspace = ({ testId }: { testId: string }) => (
  <AudioStudioWorkspace mode="sound-effects" testId={testId} />
);
