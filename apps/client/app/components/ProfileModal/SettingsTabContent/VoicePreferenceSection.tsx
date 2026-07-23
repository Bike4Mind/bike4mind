import { useUser } from '@client/app/contexts/UserContext';
import { api } from '@client/app/contexts/ApiContext';
import { isAxiosError } from 'axios';
import { Box, Grid, Typography, Select, Option, CircularProgress, Button, Textarea } from '@mui/joy';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { cardSurfaceSx } from '@client/app/components/ProfileModal/settingsStyles';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';

// Available voices from OpenAI realtime API
// The real-time API has a more limited selection than TTS API
// Only alloy, echo, and shimmer are available in both APIs
const AVAILABLE_VOICES = [
  { value: 'alloy', label: 'Alloy', description: 'Professional and balanced (Female)' },
  { value: 'cedar', label: 'Cedar', description: 'Warm and grounded (Male)' },
  { value: 'echo', label: 'Echo', description: 'Clear and articulate (Male)' },
  { value: 'marin', label: 'Marin', description: 'Natural and expressive (Female)' },
  { value: 'shimmer', label: 'Shimmer', description: 'Energetic and vibrant (Female)' },
] as const;

const DEFAULT_SAMPLE_TEXT = "Hello! This is how my voice sounds. I'm ready to help you with anything you need.";

const VoicePreferenceSection = () => {
  const { currentUser, setCurrentUser } = useUser();
  const [isLoading, setIsLoading] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [sampleText, setSampleText] = useState(DEFAULT_SAMPLE_TEXT);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
    };
  }, []);

  const handleVoiceChange = async (_: SyntheticEvent | null, newValue: string | null) => {
    if (!currentUser || newValue === undefined) return;

    setIsLoading(true);
    try {
      const response = await api.put(`/api/users/${currentUser.id}/update`, {
        preferredVoice: newValue,
      });

      setCurrentUser(response.data);

      if (newValue) {
        toast.success(`Voice preference updated to ${AVAILABLE_VOICES.find(v => v.value === newValue)?.label}`);
      } else {
        toast.success('Voice preference cleared (will use system default)');
      }
    } catch (error) {
      console.error('Failed to update voice preference:', error);
      toast.error('Failed to update voice preference');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestVoice = async () => {
    if (!sampleText.trim()) {
      toast.error('Please enter some text to test the voice');
      return;
    }

    const voiceToTest = selectedVoice || 'alloy';

    setIsTesting(true);

    try {
      // Stop any currently playing audio and release its blob URL
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }

      // Call the TTS API; it approximates the real-time voice for testing
      const response = await api.post(
        '/api/ai/text-to-speech',
        {
          text: sampleText,
          voice: voiceToTest,
        },
        {
          responseType: 'blob',
          timeout: 30000,
          validateStatus: status => status === 200,
          skipAuthRefresh: true, // Prevent infinite retry loop on 401 (missing OpenAI key)
        }
      );

      // response.data is already a Blob when responseType is 'blob'
      const audioBlob = response.data;

      const audioUrl = URL.createObjectURL(audioBlob);
      audioUrlRef.current = audioUrl;
      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.onended = () => {
        setIsTesting(false);
        URL.revokeObjectURL(audioUrl);
        audioUrlRef.current = null;
      };

      audio.onerror = event => {
        console.error('Audio playback error:', event);
        console.error('Audio element state:', {
          error: audio.error,
          readyState: audio.readyState,
          networkState: audio.networkState,
        });
        setIsTesting(false);
        URL.revokeObjectURL(audioUrl);
        audioUrlRef.current = null;

        const errorCode = audio.error?.code;
        if (errorCode === 1) {
          toast.error('Audio loading was aborted');
        } else if (errorCode === 2) {
          toast.error('Network error while loading audio');
        } else if (errorCode === 3) {
          toast.error('Audio format not supported by browser');
        } else if (errorCode === 4) {
          toast.error('Audio source not available');
        } else {
          toast.error('Failed to play voice sample');
        }
      };

      try {
        await audio.play();
      } catch (playError) {
        console.error('Audio play() failed:', playError);
        setIsTesting(false);
        URL.revokeObjectURL(audioUrl);
        audioUrlRef.current = null;

        // Handle autoplay restrictions (audio.play() rejects with a DOMException)
        const errorName = playError instanceof DOMException ? playError.name : '';
        if (errorName === 'NotAllowedError') {
          toast.error('Browser blocked audio playback. Please interact with the page first.');
        } else if (errorName === 'NotSupportedError') {
          toast.error('Audio format not supported by your browser');
        } else {
          // DOMException doesn't extend Error in most browsers, so check both to
          // recover the clean `.message` rather than falling back to String().
          const message =
            playError instanceof DOMException || playError instanceof Error ? playError.message : String(playError);
          toast.error(`Playback failed: ${message}`);
        }
        // Don't re-throw - we've already handled the error
        return;
      }
    } catch (error) {
      console.error('Voice test failed:', error);

      if (!isAxiosError(error)) {
        // Non-Axios failure (unexpected)
        toast.error('Voice test failed. Please try again.');
        setIsTesting(false);
        return;
      }

      if (error.code === 'ECONNABORTED' || error.code === 'ERR_CANCELED') {
        toast.error('Request timed out. Please try again.');
      } else if (error.response) {
        // HTTP error response
        const status = error.response.status;

        // The error response is a blob, need to parse it
        const data: unknown = error.response.data;
        let errorMessage = 'Unknown error';
        try {
          if (data instanceof Blob) {
            const text = await data.text();
            const errorData = JSON.parse(text) as { error?: string };
            errorMessage = errorData.error || errorMessage;
          } else if (data && typeof data === 'object' && (data as { error?: string }).error) {
            errorMessage = (data as { error: string }).error;
          }
        } catch (parseError) {
          console.error('Failed to parse error response:', parseError);
        }

        if (status === 401) {
          toast.error('OpenAI API key not configured. Please contact your administrator.');
        } else if (status === 429) {
          toast.error('Rate limit exceeded. Please try again later.');
        } else if (status === 400) {
          toast.error('Invalid request. Please check your input.');
        } else {
          toast.error(`Error: ${errorMessage}`);
        }
      } else if (error.request) {
        // Request made but no response received
        toast.error('No response from server. Please check your connection.');
      } else {
        toast.error('Voice test failed. Please try again.');
      }

      setIsTesting(false);
    }
  };

  const handleStopTest = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setIsTesting(false);
  };

  const selectedVoice = currentUser?.preferredVoice || '';
  const selectedVoiceInfo = AVAILABLE_VOICES.find(voice => voice.value === selectedVoice);

  return (
    <SectionContainer title="Voice Preferences" subtitle="Customize your preferred voice for voice sessions">
      <Grid container spacing={2}>
        <Grid xs={12} md={8}>
          <Box
            sx={theme => ({
              ...cardSurfaceSx(theme),
              display: 'flex',
              alignItems: 'flex-start',
              gap: '16px',
              height: '100%',
            })}
          >
            <GraphicEqIcon sx={{ fontSize: '24px', color: 'primary.500', mt: 0.5 }} />

            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500, mb: 1 }}>
                Assistant Voice
              </Typography>

              <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
                Choose your preferred voice for voice sessions. This will be used instead of the system default. Note:
                You&apos;ll need to start a new voice session for the change to take effect.
              </Typography>

              <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, mb: 2 }}>
                <Select
                  value={selectedVoice}
                  onChange={handleVoiceChange}
                  placeholder="Use system default"
                  disabled={isLoading}
                  size="md"
                  sx={{ minWidth: '200px', flex: { xs: '1 1 100%', sm: '0 1 auto' } }}
                  startDecorator={isLoading && <CircularProgress size="sm" />}
                >
                  <Option value="">Use system default</Option>
                  {AVAILABLE_VOICES.map(voice => (
                    <Option key={voice.value} value={voice.value}>
                      {voice.label}
                    </Option>
                  ))}
                </Select>

                <Button
                  data-testid="voice-test-btn"
                  size="md"
                  variant="outlined"
                  color="primary"
                  startDecorator={isTesting ? <StopIcon /> : <PlayArrowIcon />}
                  onClick={isTesting ? handleStopTest : handleTestVoice}
                  loading={isTesting}
                  disabled={isLoading}
                  sx={{ minWidth: '120px', flexShrink: 0 }}
                >
                  {isTesting ? 'Stop Test' : 'Test Voice'}
                </Button>
              </Box>

              {/* Voice Sample Text Area */}
              <Box sx={{ mb: 2 }}>
                <Typography level="body-sm" sx={{ mb: 1, fontWeight: 500 }}>
                  Test Text
                </Typography>
                <Textarea
                  value={sampleText}
                  onChange={e => setSampleText(e.target.value)}
                  placeholder="Enter text to test how the voice sounds..."
                  minRows={2}
                  maxRows={4}
                  size="sm"
                  disabled={isLoading || isTesting}
                  sx={{
                    fontSize: '14px',
                    '&:focus-within': {
                      borderColor: 'primary.500',
                    },
                  }}
                />
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.tertiary' }}>
                  Type or paste text to hear how it sounds in the selected voice
                </Typography>
              </Box>

              {selectedVoiceInfo && (
                <Typography
                  level="body-sm"
                  sx={{
                    color: 'text.secondary',
                    fontStyle: 'italic',
                    backgroundColor: 'background.level1',
                    p: 1.5,
                    borderRadius: 'sm',
                  }}
                >
                  <strong>{selectedVoiceInfo.label}:</strong> {selectedVoiceInfo.description}
                </Typography>
              )}

              <Typography
                level="body-xs"
                sx={{
                  color: 'text.tertiary',
                  mt: 1,
                  p: 1,
                  backgroundColor: 'background.level1',
                  borderRadius: 'sm',
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <strong>Note:</strong> Voice testing uses the TTS API with the same voice models as the real-time API.
                The voices are identical, though real-time sessions may have slight variations in responsiveness and
                natural cadence.
              </Typography>

              {!selectedVoice && (
                <Typography
                  level="body-sm"
                  sx={{
                    color: 'text.secondary',
                    fontStyle: 'italic',
                    backgroundColor: 'background.level1',
                    p: 1.5,
                    borderRadius: 'sm',
                  }}
                >
                  Using system default voice settings from admin configuration
                </Typography>
              )}
            </Box>
          </Box>
        </Grid>
      </Grid>
    </SectionContainer>
  );
};

export default VoicePreferenceSection;
