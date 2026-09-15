/**
 * Side drawer with full debug info for voice sessions.
 *
 * Accessible via Shift+click or long-press on the voice button.
 * Shows: connection info, audio visualization, transcript, debug log.
 */

import AudioVisualization from '@client/app/components/Session/VoiceSessionModal/AudioVisualization';
import type { UseVoiceSessionEngine } from '@client/app/components/Session/VoiceSessionModal/useVoiceSessionEngine';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  ModalClose,
  Stack,
  Typography,
  useTheme,
} from '@mui/joy';
import BugReportIcon from '@mui/icons-material/BugReport';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import StopIcon from '@mui/icons-material/Stop';
import React, { useEffect, useRef } from 'react';
import { keyframes } from '@mui/system';

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
`;

interface VoiceDebugDrawerProps {
  open: boolean;
  onClose: () => void;
  engine: UseVoiceSessionEngine;
}

const VoiceDebugDrawer: React.FC<VoiceDebugDrawerProps> = ({ open, onClose, engine }) => {
  const theme = useTheme();
  const debugLogRef = useRef<HTMLDivElement>(null);

  const {
    connectionStatus,
    isEnding,
    isActive,
    isMuted,
    userStream,
    assistantStream,
    selectedVoice,
    activeSessionId,
    transcriptItems,
    debugLogs,
    copyDebugLogs,
    clearDebugLogs,
    toggleMute,
    endSession,
  } = engine;

  useEffect(() => {
    if (debugLogRef.current && open) {
      debugLogRef.current.scrollTop = debugLogRef.current.scrollHeight;
    }
  }, [debugLogs, open]);

  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'connecting':
      case 'reconnecting':
        return theme.palette.voiceModal.statusColors.connecting;
      case 'connected':
        return theme.palette.voiceModal.statusColors.connected;
      case 'disconnected':
        return theme.palette.voiceModal.statusColors.disconnected;
      default:
        return theme.palette.voiceModal.statusColors.unknown;
    }
  };

  const getStatusText = () => {
    if (isEnding) return 'Ending session...';
    switch (connectionStatus) {
      case 'connecting':
        return 'Connecting...';
      case 'reconnecting':
        return 'Reconnecting...';
      case 'connected':
        return 'Connected';
      case 'disconnected':
        return 'Disconnected';
      default:
        return 'Unknown';
    }
  };

  const getVoiceLabel = () => {
    if (!selectedVoice) return null;
    switch (selectedVoice) {
      case 'alloy':
        return 'Alloy (Female)';
      case 'echo':
        return 'Echo (Male)';
      case 'shimmer':
        return 'Shimmer (Female)';
      default:
        return selectedVoice;
    }
  };

  const visibleTranscript = transcriptItems.filter(item => !item.isHidden);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      size="md"
      slotProps={{
        content: {
          sx: {
            width: { xs: '100vw', sm: '400px' },
            maxWidth: '100vw',
          },
        },
        backdrop: {
          sx: {
            backgroundColor: 'rgba(0,0,0,0.3)',
            backdropFilter: 'blur(2px)',
          },
        },
      }}
    >
      <Stack sx={{ height: '100%', overflow: 'hidden' }}>
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            px: 2,
            py: 1.5,
            borderBottom: `1px solid ${theme.palette.divider}`,
          }}
        >
          <BugReportIcon sx={{ fontSize: 20, color: theme.palette.text.secondary }} />
          <Typography level="title-md" fontWeight="600" sx={{ flex: 1 }}>
            Voice Debug
          </Typography>
          <ModalClose sx={{ position: 'static' }} />
        </Box>

        {/* Connection status */}
        <Box sx={{ px: 2, py: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
            <Box
              sx={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                backgroundColor: getStatusColor(),
                animation:
                  connectionStatus === 'connecting' || isEnding ? `${pulse} 1.5s ease-in-out infinite` : 'none',
              }}
            />
            <Typography level="body-sm" fontWeight="500">
              {getStatusText()}
            </Typography>
          </Box>

          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {selectedVoice && (
              <Chip
                variant="soft"
                color="primary"
                size="sm"
                startDecorator={<RecordVoiceOverIcon sx={{ fontSize: 12 }} />}
                sx={{ fontSize: '11px' }}
              >
                {getVoiceLabel()}
              </Chip>
            )}
            {activeSessionId && (
              <Chip variant="outlined" color="neutral" size="sm" sx={{ fontSize: '10px', fontFamily: 'monospace' }}>
                {activeSessionId.slice(0, 8)}...
              </Chip>
            )}
          </Box>
        </Box>

        {/* Audio visualization */}
        {isActive && (
          <Box sx={{ px: 2, py: 2, borderBottom: `1px solid ${theme.palette.divider}` }}>
            <Box sx={{ display: 'flex', gap: 3, justifyContent: 'center' }}>
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                <Typography level="body-xs" fontWeight="500" color={!isMuted ? 'success' : 'neutral'}>
                  You {isMuted ? '(Muted)' : ''}
                </Typography>
                <AudioVisualization isActive={!isMuted} isUser={true} audioStream={userStream} />
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                <Typography level="body-xs" fontWeight="500" color="primary">
                  Assistant
                </Typography>
                <AudioVisualization isActive={true} isUser={false} audioStream={assistantStream} />
              </Box>
            </Box>
          </Box>
        )}

        {/* Transcript */}
        <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <Box sx={{ px: 2, py: 1, borderBottom: `1px solid ${theme.palette.divider}` }}>
            <Typography level="body-xs" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">
              Transcript ({visibleTranscript.length})
            </Typography>
          </Box>

          <Box sx={{ px: 2, py: 1 }}>
            {visibleTranscript.length === 0 ? (
              <Typography level="body-sm" color="neutral" sx={{ py: 2, textAlign: 'center' }}>
                {isActive ? 'Waiting for conversation...' : 'No transcript yet'}
              </Typography>
            ) : (
              visibleTranscript.map(item => (
                <Box
                  key={item.itemId}
                  sx={{
                    display: 'flex',
                    gap: 1,
                    py: 0.75,
                    borderBottom: `1px solid ${theme.palette.divider}`,
                    '&:last-child': { borderBottom: 'none' },
                  }}
                >
                  <Typography
                    level="body-xs"
                    fontWeight="600"
                    color={item.role === 'user' ? 'success' : 'primary'}
                    sx={{ width: '60px', flexShrink: 0, textTransform: 'capitalize' }}
                  >
                    {item.role || 'system'}
                  </Typography>
                  <Typography level="body-xs" sx={{ flex: 1, wordBreak: 'break-word' }}>
                    {item.title || '...'}
                    {item.status === 'IN_PROGRESS' && (
                      <CircularProgress size="sm" sx={{ '--CircularProgress-size': '10px', ml: 0.5 }} />
                    )}
                  </Typography>
                </Box>
              ))
            )}
          </Box>
        </Box>

        <Divider />

        {/* Debug log panel */}
        <Box sx={{ height: '220px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              px: 2,
              py: 0.75,
              borderBottom: `1px solid ${theme.palette.divider}`,
              backgroundColor: theme.palette.mode === 'dark' ? 'rgba(30,30,30,0.95)' : 'rgba(245,245,245,0.95)',
            }}
          >
            <Typography level="body-xs" fontWeight="600" fontFamily="monospace">
              Debug Log ({debugLogs.length})
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              <IconButton
                variant="plain"
                color="neutral"
                size="sm"
                onClick={copyDebugLogs}
                sx={{ minWidth: '24px', minHeight: '24px' }}
              >
                <ContentCopyIcon sx={{ fontSize: 14 }} />
              </IconButton>
              <IconButton
                variant="plain"
                color="danger"
                size="sm"
                onClick={clearDebugLogs}
                sx={{ minWidth: '24px', minHeight: '24px' }}
              >
                <DeleteOutlineIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Box>
          </Box>

          <Box
            ref={debugLogRef}
            sx={{
              flex: 1,
              overflow: 'auto',
              px: 1.5,
              py: 1,
              fontFamily: 'monospace',
              fontSize: '11px',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              color: theme.palette.mode === 'dark' ? '#00ff00' : '#1a1a1a',
              backgroundColor: theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,0.95)',
            }}
          >
            {debugLogs.length === 0 ? (
              <Typography level="body-xs" color="neutral" fontFamily="monospace">
                Waiting for events...
              </Typography>
            ) : (
              debugLogs.map((log, i) => <div key={i}>{log}</div>)
            )}
          </Box>
        </Box>

        {/* Controls footer */}
        {isActive && (
          <Box
            sx={{
              display: 'flex',
              gap: 1,
              px: 2,
              py: 1.5,
              borderTop: `1px solid ${theme.palette.divider}`,
            }}
          >
            <Button
              variant={isMuted ? 'solid' : 'outlined'}
              color={isMuted ? 'danger' : 'neutral'}
              size="sm"
              startDecorator={isMuted ? <MicOffIcon sx={{ fontSize: 16 }} /> : <MicIcon sx={{ fontSize: 16 }} />}
              onClick={toggleMute}
              disabled={connectionStatus !== 'connected' || isEnding}
              sx={{ flex: 1 }}
            >
              {isMuted ? 'Unmute' : 'Mute'}
            </Button>
            <Button
              variant="solid"
              color="danger"
              size="sm"
              startDecorator={
                isEnding ? (
                  <CircularProgress size="sm" sx={{ '--CircularProgress-size': '14px' }} />
                ) : (
                  <StopIcon sx={{ fontSize: 16 }} />
                )
              }
              onClick={endSession}
              disabled={isEnding}
              sx={{ flex: 1 }}
            >
              {isEnding ? 'Ending...' : 'End Session'}
            </Button>
          </Box>
        )}
      </Stack>
    </Drawer>
  );
};

export default VoiceDebugDrawer;
