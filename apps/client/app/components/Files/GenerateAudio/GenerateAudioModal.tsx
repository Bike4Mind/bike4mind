import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  DialogContent,
  DialogTitle,
  Divider,
  Modal,
  ModalClose,
  ModalDialog,
  Textarea,
  ToggleButtonGroup,
  Typography,
} from '@mui/joy';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import {
  estimateSoundCreditCost,
  estimateTtsCreditCost,
  SOUND_EFFECTS_MAX_INPUT_CHARS,
  TTS_MAX_INPUT_CHARS,
} from '@bike4mind/common';
import { useAudioGenSettings } from '@client/app/stores/useAudioGenSettings';
import { AudioGenerationSettings } from '@client/app/components/Session/AISettings/AudioGenerationSettings';
import { useGenerateAudio } from './useGenerateAudio';

const GenerateAudioModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { mode, ttsProvider, durationSeconds, setMode } = useAudioGenSettings();
  const [text, setText] = useState('');
  const { generate, isGenerating, result, clearResult } = useGenerateAudio();

  const maxChars = mode === 'tts' ? TTS_MAX_INPUT_CHARS[ttsProvider] : SOUND_EFFECTS_MAX_INPUT_CHARS;
  const overLimit = text.length > maxChars;

  const estimatedCredits = useMemo(() => {
    if (mode === 'sound-effects')
      return estimateSoundCreditCost('elevenlabs', { durationSeconds: durationSeconds ?? undefined });
    // OpenAI defaults to tts-1 server-side; naming it keeps the estimate off the
    // conservative highest-rate fallback (which would ~2x the shown cost).
    return estimateTtsCreditCost(ttsProvider, ttsProvider === 'openai' ? 'tts-1' : undefined, text.length);
  }, [mode, ttsProvider, durationSeconds, text.length]);

  const handleClose = () => {
    clearResult();
    onClose();
  };

  const handleModeChange = (next: 'tts' | 'sound-effects' | null) => {
    if (!next || next === mode) return;
    setMode(next);
    clearResult();
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog sx={{ width: 'min(560px, 94vw)', maxWidth: '94vw' }} data-testid="generate-audio-modal">
        <ModalClose data-testid="generate-audio-close-btn" />
        <DialogTitle>
          <GraphicEqIcon />
          Generate Audio
        </DialogTitle>
        <DialogContent sx={{ gap: 2 }}>
          <ToggleButtonGroup
            value={mode}
            onChange={(_, value) => handleModeChange(value)}
            size="sm"
            sx={{ alignSelf: 'flex-start' }}
          >
            <Button value="tts" data-testid="generate-audio-mode-tts">
              Text to speech
            </Button>
            <Button value="sound-effects" data-testid="generate-audio-mode-sfx">
              Sound effect
            </Button>
          </ToggleButtonGroup>

          <Box>
            <Textarea
              value={text}
              onChange={e => setText(e.target.value)}
              minRows={3}
              maxRows={8}
              placeholder={
                mode === 'tts'
                  ? 'Enter the text you want spoken aloud...'
                  : 'Describe the sound effect (e.g. "gentle rain on a tin roof")...'
              }
              error={overLimit}
              disabled={isGenerating}
              data-testid="generate-audio-text-input"
            />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}>
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                ~{estimatedCredits} credit{estimatedCredits === 1 ? '' : 's'} estimated
              </Typography>
              <Typography level="body-xs" sx={{ color: overLimit ? 'danger.500' : 'text.tertiary' }}>
                {text.length} / {maxChars}
              </Typography>
            </Box>
          </Box>

          <Divider />
          <AudioGenerationSettings mode={mode} />
          <Divider />

          <Button
            onClick={() => generate(text)}
            loading={isGenerating}
            disabled={!text.trim() || overLimit}
            data-testid="generate-audio-submit-btn"
          >
            Generate
          </Button>

          {result && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Box
                component="audio"
                controls
                autoPlay
                src={result.url}
                sx={{ width: '100%' }}
                data-testid="generate-audio-player"
              />
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                {result.saved
                  ? 'Saved to your Files - close this dialog to find it in the File Browser.'
                  : 'This audio was not saved to your Files.'}
              </Typography>
            </Box>
          )}
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default GenerateAudioModal;
