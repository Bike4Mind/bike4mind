/**
 * VoiceRecordButton - Prompt via Voice button for speech-to-text input.
 *
 * Styled to match VoiceInlineIndicator patterns:
 *  - Idle: neutral outlined icon button
 *  - Recording: themed pill with animated "Recording..." + green mini equalizer + cancel icon
 *  - Transcribing: themed pill with animated "Transcribing..." text
 *
 * During recording the parent should replace the main send button with a
 * confirm (checkmark) button that calls `onConfirmRecording`.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { Box, IconButton, Tooltip, useTheme } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import MicTwoToneIcon from '@mui/icons-material/MicTwoTone';
import { keyframes } from '@mui/system';
import { api } from '@client/app/contexts/ApiContext';
import { useAudioAnalyzer } from '@client/app/hooks/useAudioAnalyzer';
import { grayAlpha, green } from '@client/app/utils/themes/colors';

// Animations (matching VoiceInlineIndicator)

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
`;

const letterWave = keyframes`
  0% { opacity: 1; }
  100% { opacity: 0.5; }
`;

/** Renders each character with a staggered opacity wave animation. */
const AnimatedText: React.FC<{ text: string; color: string }> = ({ text, color }) => (
  <Box component="span" sx={{ display: 'inline-flex', flexShrink: 0, fontSize: 'var(--joy-fontSize-xs)', color }}>
    {text.split('').map((char, i) => (
      <Box
        key={i}
        component="span"
        sx={{
          animation: `${letterWave} 0.75s infinite alternate`,
          animationDelay: `${i * 0.1}s`,
        }}
      >
        {char}
      </Box>
    ))}
  </Box>
);

// MiniEqualizer (matching VoiceInlineIndicator)

const MiniEqualizer: React.FC<{ stream: MediaStream | null }> = ({ stream }) => {
  const audioData = useAudioAnalyzer(stream);

  const indices = [0, 2, 5, 7, 10, 12, 14];
  const bars = indices.map(i => audioData.frequencyBars[i] ?? 0);

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: '2px',
        width: '28px',
        height: '20px',
        flexShrink: 0,
      }}
      data-testid="voice-record-equalizer"
    >
      {bars.map((intensity, i) => (
        <Box
          key={i}
          sx={{
            width: '3px',
            borderRadius: '1.5px',
            backgroundColor: green[500],
            height: audioData.isActive ? `${Math.max(3, Math.round(intensity * 20))}px` : '6px',
            transition: 'height 0.06s ease-out',
            opacity: audioData.isActive ? 1 : 0.5,
          }}
        />
      ))}
    </Box>
  );
};

// VoiceRecordButton

interface IProps {
  onRecordingStart: () => void;
  onRecordingEnd: (prompt: string) => void;
  onRecordingError: () => void;
  disabled?: boolean;
}

export interface VoiceRecordButtonRef {
  /** Stop recording and submit for transcription. Called by the parent confirm button. */
  confirmRecording: () => void;
}

export const VoiceRecordButton = forwardRef<VoiceRecordButtonRef, IProps>(
  ({ onRecordingStart, onRecordingEnd, onRecordingError, disabled = false }, ref) => {
    const theme = useTheme();
    const [permission, setPermission] = useState(false);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    // When true, onstop will transcribe; when false (cancel), onstop discards.
    const shouldTranscribeRef = useRef(false);

    // Mirror stream/recorder into refs so the unmount-only effect below can
    // release the mic without re-running every time they change.
    const streamRef = useRef<MediaStream | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    useEffect(() => {
      streamRef.current = stream;
      recorderRef.current = recorder;
    }, [stream, recorder]);

    // Defensive unmount cleanup: if the component is unmounted mid-recording
    // (e.g. the parent stops rendering it), stop the recorder and release the
    // MediaStream tracks so the browser mic indicator turns off. Without this,
    // an in-progress recording would leak the live microphone.
    useEffect(
      () => () => {
        const activeRecorder = recorderRef.current;
        if (activeRecorder && activeRecorder.state === 'recording') {
          activeRecorder.stop();
        }
        streamRef.current?.getTracks().forEach(track => track.stop());
      },
      []
    );

    const cleanup = useCallback(() => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      setIsRecording(false);
      setStream(null);
      setRecorder(null);
      setPermission(false);
    }, [stream]);

    /** Cancel: stop recorder without transcribing, reset recording state */
    const cancelRecording = useCallback(() => {
      shouldTranscribeRef.current = false;
      if (recorder && recorder.state === 'recording') {
        recorder.stop();
      }
      cleanup();
      onRecordingError(); // signals parent that recording ended without result
    }, [recorder, cleanup, onRecordingError]);

    /** Confirm: stop recorder and trigger transcription */
    const confirmRecording = useCallback(() => {
      shouldTranscribeRef.current = true;
      if (recorder && recorder.state === 'recording') {
        recorder.stop();
      }
      // cleanup of stream/state happens in onstop after transcribe kicks off
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      setIsRecording(false);
      setStream(null);
      setRecorder(null);
      setPermission(false);
    }, [recorder, stream]);

    useImperativeHandle(ref, () => ({ confirmRecording }), [confirmRecording]);

    const handleTranscribe = async (audioBlob: Blob) => {
      setIsLoading(true);
      try {
        // Step 1: ask the server for a presigned S3 POST. The server enforces
        // size/mime policy at the S3 boundary, so we never push the audio
        // through Lambda (which has a 6 MB payload cap).
        const mimeType = 'audio/webm';
        const initResponse = await api.post<{
          url: string;
          fields: Record<string, string>;
          fileKey: string;
        }>('/api/ai/transcribe/init', {
          mimeType,
          fileSize: audioBlob.size,
        });
        const { url, fields, fileKey } = initResponse.data;

        // Step 2: upload the audio directly to S3 using the presigned POST
        // policy. fields MUST come before the file field per S3's contract.
        const uploadForm = new FormData();
        Object.entries(fields).forEach(([k, v]) => uploadForm.append(k, v));
        uploadForm.append('file', audioBlob, 'speech.webm');

        const uploadResponse = await fetch(url, { method: 'POST', body: uploadForm });
        if (!uploadResponse.ok) {
          throw new Error(`S3 upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
        }

        // Step 3: trigger transcription against the uploaded object.
        const response = await api.post<{ text: string }>('/api/ai/transcribe', { fileKey });
        if (response?.data?.text) {
          onRecordingEnd(response.data.text);
        }
      } catch (error) {
        console.error('Transcription error:', error);
        onRecordingError();
      } finally {
        setIsLoading(false);
      }
    };

    const startRecording = async () => {
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        setStream(audioStream);
        setPermission(true);

        const mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });
        setRecorder(mediaRecorder);

        const chunks: Blob[] = [];
        mediaRecorder.ondataavailable = e => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
          if (shouldTranscribeRef.current) {
            const audioBlob = new Blob(chunks, { type: 'audio/webm' });
            handleTranscribe(audioBlob);
          }
          // If cancelled, chunks are discarded
        };

        shouldTranscribeRef.current = false;
        mediaRecorder.start();
        setIsRecording(true);
        onRecordingStart();
      } catch (err) {
        console.error('Recording error:', err);
        onRecordingError();
      }
    };

    const handleMicrophoneClick = () => {
      if (!permission) {
        startRecording();
      } else if (stream && !isRecording) {
        startRecording();
      }
    };

    // Transcribing state
    if (isLoading) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            padding: '4px 10px',
            minHeight: '32px',
            borderRadius: '6px',
            backgroundColor: theme.palette.mode === 'dark' ? theme.palette.border.solid : grayAlpha[150][20],
            animation: `${fadeIn} 0.2s ease-out`,
          }}
          data-testid="voice-record-transcribing"
        >
          <AnimatedText text="Transcribing..." color={theme.palette.text.tertiary} />
        </Box>
      );
    }

    // Recording state
    if (isRecording) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            animation: `${fadeIn} 0.2s ease-out`,
          }}
          data-testid="voice-record-strip"
        >
          {/* Recording pill with animated text + green equalizer + cancel */}
          <Tooltip title="Cancel recording" placement="top">
            <Box
              onClick={cancelRecording}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                padding: '4px 8px 4px 10px',
                minHeight: '32px',
                borderRadius: '6px',
                cursor: 'pointer',
                backgroundColor: theme.palette.mode === 'dark' ? theme.palette.border.solid : grayAlpha[150][20],
                '&:hover': {
                  backgroundColor: theme.palette.mode === 'dark' ? '#363B40' : grayAlpha[150][30],
                },
              }}
              data-testid="voice-record-cancel-pill"
            >
              <AnimatedText text="Recording" color={theme.palette.text.tertiary} />
              <MiniEqualizer stream={stream} />
              <CloseIcon sx={{ fontSize: 20, color: theme.palette.text.tertiary }} />
            </Box>
          </Tooltip>
        </Box>
      );
    }

    // Idle state
    return (
      <Tooltip title="Prompt via Voice" placement="top">
        <IconButton
          sx={{
            borderRadius: '6px',
            maxHeight: '32px',
            maxWidth: '32px',
            minHeight: '32px',
            minWidth: '32px',
          }}
          color="neutral"
          variant="outlined"
          size="md"
          onClick={handleMicrophoneClick}
          data-testid="voice-record-btn"
          disabled={disabled}
        >
          <MicTwoToneIcon sx={{ fontSize: '18px' }} />
        </IconButton>
      </Tooltip>
    );
  }
);

VoiceRecordButton.displayName = 'VoiceRecordButton';

export default VoiceRecordButton;
