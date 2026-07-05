/**
 * Compact, non-blocking voice session controls.
 *
 * Two exports:
 *  - VoiceControlsStrip: thin status bar rendered above the chat input row
 *  - VoiceInlineButton: the voice toggle button rendered alongside send/stop
 *
 * Button behavior:
 *  - Single click: toggle voice on/off
 *  - Shift+click or long-press (500ms): open debug drawer
 */

import { useAudioAnalyzer } from '@client/app/hooks/useAudioAnalyzer';
import type { UseVoiceSessionEngine } from '@client/app/components/Session/VoiceSessionModal/useVoiceSessionEngine';
import { Box, IconButton, Tooltip, Typography, useTheme } from '@mui/joy';
import { grayAlpha, green, red, redAlpha } from '@client/app/utils/themes/colors';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import StopIcon from '@mui/icons-material/Stop';
import React, { useCallback, useRef } from 'react';
import { keyframes } from '@mui/system';

const pulseGlow = keyframes`
  0%, 100% { box-shadow: 0 0 2px 1px currentColor; }
  50% { box-shadow: 0 0 4px 2px currentColor; }
`;

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

// DEBUG: override voice state to preview styles.
// Uncomment ONE line below to force a specific state, then save:
// export const VOICE_DEBUG_STATE: 'connecting' | 'connected' | 'ending' | null = 'connecting';
// export const VOICE_DEBUG_STATE: 'connecting' | 'connected' | 'ending' | null = 'connected';
// export const VOICE_DEBUG_STATE: 'connecting' | 'connected' | 'ending' | null = 'ending';
export const VOICE_DEBUG_STATE: 'connecting' | 'connected' | 'ending' | null = null; // null = use real engine state
// END DEBUG

// VoiceControlsStrip

interface VoiceControlsStripProps {
  engine: UseVoiceSessionEngine;
}

export const VoiceControlsStrip: React.FC<VoiceControlsStripProps> = ({ engine }) => {
  const theme = useTheme();
  const {
    connectionStatus: realStatus,
    isEnding: realIsEnding,
    isActive: realIsActive,
    isMuted,
    userStream,
    toggleMute,
    endSession,
  } = engine;

  const connectionStatus = VOICE_DEBUG_STATE === 'ending' ? 'connected' : (VOICE_DEBUG_STATE ?? realStatus);
  const isEnding = VOICE_DEBUG_STATE === 'ending' ? true : VOICE_DEBUG_STATE ? false : realIsEnding;
  const isActive = VOICE_DEBUG_STATE ? true : realIsActive;

  if (!isActive) return null;

  const isConnecting = connectionStatus === 'connecting';
  const isReconnecting = connectionStatus === 'reconnecting';
  const isConnected = connectionStatus === 'connected';
  // Reconnecting behaves like connecting in the strip: show a status pill that
  // the user can tap to give up and end the session.
  const isPending = isConnecting || isReconnecting;
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        animation: `${fadeIn} 0.2s ease-out`,
      }}
      data-testid="voice-controls-strip"
    >
      {/* Mute toggle button - visible in all active states */}
      {
        <Tooltip title={isMuted ? 'Unmute' : 'Mute'} placement="top">
          <IconButton
            variant="plain"
            color="neutral"
            size="sm"
            onClick={toggleMute}
            disabled={isConnecting || isEnding}
            sx={{
              borderRadius: '6px',
              minWidth: '32px',
              minHeight: '32px',
              maxWidth: '32px',
              maxHeight: '32px',
              ...(isMuted
                ? {
                    backgroundColor: redAlpha[600][20],
                    color: red[600],
                    '&:hover': {
                      backgroundColor: redAlpha[600][20],
                    },
                  }
                : {
                    backgroundColor: theme.palette.mode === 'dark' ? theme.palette.border.solid : grayAlpha[150][20],
                    '&:hover': {
                      backgroundColor: theme.palette.mode === 'dark' ? '#363B40' : grayAlpha[150][30],
                    },
                  }),
            }}
            data-testid="voice-mute-btn"
          >
            {isMuted ? <MicOffIcon sx={{ fontSize: 16, color: red[600] }} /> : <MicIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </Tooltip>
      }

      {/* Connecting / reconnecting / ending: status pill with stop icon */}
      {isPending || isEnding ? (
        <Tooltip title={isPending ? 'Cancel connection' : 'Ending voice session...'} placement="top">
          <Box
            onClick={isPending ? endSession : undefined}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              padding: '4px 8px 4px 10px',
              minHeight: '32px',
              borderRadius: '6px',
              cursor: isPending ? 'pointer' : 'default',
              backgroundColor: theme.palette.mode === 'dark' ? theme.palette.border.solid : grayAlpha[150][20],
              '&:hover': isPending
                ? {
                    backgroundColor: theme.palette.mode === 'dark' ? '#363B40' : grayAlpha[150][30],
                  }
                : {},
            }}
          >
            <AnimatedText
              text={isEnding ? 'Ending...' : isReconnecting ? 'Reconnecting...' : 'Connecting...'}
              color={theme.palette.text.tertiary}
            />
            <StopIcon sx={{ fontSize: 20, color: red[600] }} />
          </Box>
        </Tooltip>
      ) : (
        /* Connected: stop button styled like voice-chat-btn */
        <Tooltip title="Click to end voice session" placement="top">
          <Box
            onClick={endSession}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1.5,
              minHeight: '32px',
              borderRadius: '6px',
              backgroundColor: theme.palette.primary.solidBg,
              color: theme.palette.primary.solidColor,
              cursor: 'pointer',
              position: 'relative',
              overflow: 'hidden',
              transition: 'all 0.2s ease-in-out',
              '&:hover': {
                backgroundColor: theme.palette.primary.solidHoverBg,
              },
            }}
            data-testid="voice-stop-btn"
          >
            {isConnected && <MiniEqualizer stream={userStream} isMuted={isMuted} barColorOverride={green[500]} />}
            <Typography level="body-xs" sx={{ color: 'inherit', fontSize: '14px' }}>
              Stop
            </Typography>
          </Box>
        </Tooltip>
      )}
    </Box>
  );
};

// VoiceInlineButton

interface VoiceInlineButtonProps {
  engine: UseVoiceSessionEngine;
  onOpenDebugPanel: () => void;
  /** Passed through so button sizing matches siblings in SessionBottom */
  fixedIconSize?: Record<string, unknown>;
  /** When true, button is disabled because user has no credits */
  creditsBlocked?: boolean;
}

const VoiceInlineButton: React.FC<VoiceInlineButtonProps> = ({
  engine,
  onOpenDebugPanel,
  fixedIconSize = {},
  creditsBlocked = false,
}) => {
  const theme = useTheme();
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const didLongPressRef = useRef(false);

  const { connectionStatus, isEnding, isActive, isMuted, connect, endSession } = engine;

  // Long-press detection
  const handlePointerDown = useCallback(() => {
    didLongPressRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      didLongPressRef.current = true;
      onOpenDebugPanel();
    }, 500);
  }, [onOpenDebugPanel]);

  const handlePointerUp = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handlePointerCancel = handlePointerUp;

  // Click handler (tap = toggle, shift = debug)
  const handleButtonClick = useCallback(
    (e: React.MouseEvent) => {
      if (didLongPressRef.current) return;

      if (e.shiftKey) {
        onOpenDebugPanel();
        return;
      }

      if (isActive) {
        endSession();
      } else {
        connect().catch(err => console.error('Failed to start voice session:', err));
      }
    },
    [isActive, connect, endSession, onOpenDebugPanel]
  );

  const getButtonColor = (): 'primary' | 'success' | 'warning' | 'danger' | 'neutral' => {
    if (isEnding) return 'neutral';
    if (isMuted) return 'danger';
    switch (connectionStatus) {
      case 'connecting':
        return 'warning';
      case 'connected':
        return 'success';
      default:
        return 'primary';
    }
  };

  const getTooltip = () => {
    if (creditsBlocked) return 'Out of credits — add credits or subscribe to use voice';
    if (isEnding) return 'Ending voice session...';
    if (isActive) {
      if (isMuted) return 'Voice active (muted) - Click to end, Shift+click for debug';
      return 'Voice active - Click to end, Shift+click for debug';
    }
    return 'Start voice session (Shift+click for debug)';
  };

  return (
    <Tooltip title={getTooltip()} placement="top">
      <IconButton
        variant="solid"
        color={getButtonColor()}
        onClick={handleButtonClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        disabled={isEnding || creditsBlocked}
        sx={{
          borderRadius: '6px',
          ...fixedIconSize,
          transition: 'all 0.2s ease-in-out',
          animation: connectionStatus === 'connecting' ? `${pulseGlow} 1.5s ease-in-out infinite` : 'none',
          color: connectionStatus === 'connecting' ? theme.palette.voiceModal.statusColors.connecting : undefined,
          '&:hover': {},
        }}
        data-testid="voice-chat-btn"
      >
        {isMuted ? <MicOffIcon sx={{ fontSize: 16 }} /> : <GraphicEqIcon sx={{ fontSize: 16 }} />}
      </IconButton>
    </Tooltip>
  );
};

// ── MiniEqualizer ─────────────────────────────────────────────────

interface MiniEqualizerProps {
  stream: MediaStream | null;
  isMuted: boolean;
  /** Override bar color (e.g. 'currentColor' to inherit from parent) */
  barColorOverride?: string;
}

/**
 * Classic equalizer with 7 vertical bars that bounce up and down in
 * real-time based on microphone audio amplitude. Sits in the controls
 * strip so it's clearly visible.
 */
const MiniEqualizer: React.FC<MiniEqualizerProps> = ({ stream, isMuted, barColorOverride }) => {
  const theme = useTheme();
  const audioData = useAudioAnalyzer(!isMuted ? stream : null);

  // Sample 7 bars spread across the frequency spectrum
  const indices = [0, 2, 5, 7, 10, 12, 14];
  const bars = indices.map(i => audioData.frequencyBars[i] ?? 0);
  const barColor =
    barColorOverride ?? (isMuted ? theme.palette.neutral[500] : theme.palette.voiceModal.audioVisualization.user);

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
      data-testid="voice-mini-equalizer"
    >
      {bars.map((intensity, i) => (
        <Box
          key={i}
          sx={{
            width: '3px',
            borderRadius: '1.5px',
            backgroundColor: barColor,
            height: audioData.isActive ? `${Math.max(3, Math.round(intensity * 20))}px` : '6px',
            transition: 'height 0.06s ease-out',
            opacity: audioData.isActive ? 1 : 0.5,
          }}
        />
      ))}
    </Box>
  );
};

export default VoiceInlineButton;
