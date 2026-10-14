import { Box, CircularProgress, IconButton, Tooltip, Typography } from '@mui/joy';
import { CallEnd, GraphicEq } from '@mui/icons-material';
import React, { useEffect, useId, useRef, useState } from 'react';
import type { Mode } from '@elevenlabs/client';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { estimateElevenLabsConversationalCost } from '@bike4mind/voice';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useUser } from '@client/app/contexts/UserContext';
import CreditsModal from '@client/app/components/subscription/CreditsModal';
import { MAX_SESSION_SECONDS } from '@server/voice/voiceSessionLimits';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import { VoiceStatusPill, frequencyBars } from '@client/app/components/common/VoiceStatusPill';
import {
  getCallFrequencyData,
  isCallActivePhase,
  useConversationalVoiceStore,
  type Phase,
} from './useConversationalVoice';
import { toolbarIconSx } from '@client/app/components/Session/toolbarIconSx';

// Same pricing POST /api/voice/v2/sessions reserves against and /end bills pro rata per second,
// so the hint cannot drift from what a call costs.
const CREDITS_PER_MINUTE = estimateElevenLabsConversationalCost(60).creditsToReserve;
const VOICE_COST_HINT = `About ${CREDITS_PER_MINUTE.toLocaleString('en-US')} credits/min, billed by the second`;
// The up-front hold POST /api/voice/v2/sessions takes (unused credits are refunded on end).
const HOLD_CREDITS = estimateElevenLabsConversationalCost(MAX_SESSION_SECONDS).creditsToReserve;
const VOICE_HOLD_HINT = `Needs ${HOLD_CREDITS.toLocaleString('en-US')} credits to start; unused credits are refunded`;
const START_LABEL = 'Voice (v2 \u2014 any model)';

const SILENT_BARS: number[] = new Array(16).fill(0);
const SILENT_LEVELS = { bars: SILENT_BARS, isActive: false };

/**
 * Per-frame equalizer levels for the live call: the user's microphone while they talk, the agent's
 * voice while it speaks. Silent until the call is connected.
 */
const useCallLevels = (connected: boolean, mode: Mode | null) => {
  const [levels, setLevels] = useState({ bars: SILENT_BARS, isActive: false });
  useEffect(() => {
    if (!connected) return;
    let frame = 0;
    const tick = () => {
      const data = getCallFrequencyData(mode === 'speaking' ? 'output' : 'input');
      if (data) {
        const bars = frequencyBars(data);
        setLevels({ bars, isActive: bars.some(b => b > 0.01) });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [connected, mode]);
  return connected ? levels : SILENT_LEVELS;
};

const pillLabel = (phase: Phase, mode: Mode | null) => {
  if (phase === 'reconnecting') return 'Reconnecting';
  if (phase === 'connected') return mode === 'speaking' ? 'Speaking' : 'Listening';
  return 'Connecting';
};

export interface VoiceCallControlsProps {
  phase: Phase;
  mode: Mode | null;
  /** 16 equalizer bands (see frequencyBars) and whether there is sound in them. */
  bars: number[];
  levelActive: boolean;
  /** Cost hint for the idle tooltip. */
  hint: string;
  onClick: () => void;
}

/**
 * What the composer shows for Voice v2: the start button, or while a call is up the status pill
 * (label + equalizer, display only - the red button is the one way to end) and the red end button.
 * Stateless so /voice-lab-style previews can render any phase.
 */
export const VoiceCallControls: React.FC<VoiceCallControlsProps> = ({
  phase,
  mode,
  bars,
  levelActive,
  hint,
  onClick,
}) => {
  const costHintId = useId();
  const isReconnecting = phase === 'reconnecting';
  const isBusy = phase === 'requesting-session' || phase === 'connecting' || isReconnecting;
  const isActive = isCallActivePhase(phase);

  const buttonLabel = isReconnecting ? 'Reconnecting\u2026' : isActive ? 'End voice call' : START_LABEL;
  const idleTitle = (
    <Box>
      {START_LABEL}
      <Typography level="body-xs" textColor="inherit" data-testid="conversational-voice-cost-hint">
        {hint}
      </Typography>
    </Box>
  );

  return (
    <>
      {isActive && (
        <VoiceStatusPill
          label={pillLabel(phase, mode)}
          bars={bars}
          isActive={phase === 'connected' && levelActive}
          data-testid="conversational-voice-status"
        />
      )}
      {/* describeChild: with a node title Joy would otherwise point aria-labelledby at the tooltip while
          open, so the hint was announced as part of the name and again as the description. Joy then no
          longer derives aria-label from a string title, so the button carries its own label in every state. */}
      <Tooltip title={isActive ? buttonLabel : idleTitle} placement="top" describeChild>
        <IconButton
          size="sm"
          variant={isActive ? 'solid' : 'outlined'}
          color={isActive ? 'danger' : 'neutral'}
          onClick={onClick}
          data-testid="conversational-voice-btn"
          aria-label={buttonLabel}
          aria-describedby={isActive ? undefined : costHintId}
        >
          {isBusy ? (
            <CircularProgress size="sm" sx={{ '--CircularProgress-size': '20px' }} />
          ) : isActive ? (
            <CallEnd />
          ) : (
            <GraphicEq sx={toolbarIconSx()} />
          )}
          {!isActive && (
            <Box component="span" id={costHintId} sx={visuallyHidden}>
              {hint}
            </Box>
          )}
        </IconButton>
      </Tooltip>
    </>
  );
};

export interface ConversationalVoiceButtonProps {
  currentSessionId: string | null;
  reasoningModelId?: string;
}

/**
 * Single toolbar control for Voice v2 - no modal. Click to start a call; while
 * a call is active the button turns red and clicking it ends the call, with a status
 * pill beside it. The conversation itself renders in the notebook (ChatCompletionProcess
 * streams each turn as a quest), so there's no separate UI surface to show.
 *
 * Call state lives in a module-level Zustand store, so it survives the route
 * remount when a new session redirects /new -> /notebooks/$id - the button on
 * the destination route reads and controls the same live call.
 */
const ConversationalVoiceButton: React.FC<ConversationalVoiceButtonProps> = ({
  currentSessionId,
  reasoningModelId,
}) => {
  const enabled = useGetSettingsValue('voiceV2Enabled');
  const navigate = useNavigate();
  const phase = useConversationalVoiceStore(s => s.phase);
  const mode = useConversationalVoiceStore(s => s.mode);
  const errorMessage = useConversationalVoiceStore(s => s.errorMessage);
  const start = useConversationalVoiceStore(s => s.start);
  const end = useConversationalVoiceStore(s => s.end);
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const { currentUser } = useUser();
  const [creditsOpen, setCreditsOpen] = useState(false);
  const levels = useCallLevels(phase === 'connected', mode);
  // The server charges the personal balance, so compare against that, not the selected account.
  // An unloaded user is not "broke": don't gate, the server's insufficient-credits check is the backstop.
  const needsCredits = enforceCredits && !!currentUser && (currentUser.currentCredits ?? 0) < HOLD_CREDITS;
  const hint = needsCredits ? VOICE_HOLD_HINT : VOICE_COST_HINT;

  // No modal to surface errors in - show them as a toast (once per error).
  const lastErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (errorMessage && errorMessage !== lastErrorRef.current) {
      lastErrorRef.current = errorMessage;
      toast.error(errorMessage);
    } else if (!errorMessage) {
      lastErrorRef.current = null;
    }
  }, [errorMessage]);

  if (!enabled) return null;

  const handleClick = () => {
    if (isCallActivePhase(phase)) {
      void end();
    } else if (needsCredits) {
      setCreditsOpen(true);
    } else {
      void start({
        sessionId: currentSessionId ?? undefined,
        reasoningModelId,
        onSessionResolved: (id, isNew) => {
          // Redirect to the freshly-created session so the user lands on the
          // notebook the call is attached to. The store (and the live call)
          // survive this route remount.
          if (isNew) navigate({ to: `/notebooks/${id}` });
        },
      });
    }
  };

  return (
    <>
      <VoiceCallControls
        phase={phase}
        mode={mode}
        bars={levels.bars}
        levelActive={levels.isActive}
        hint={hint}
        onClick={handleClick}
      />
      <CreditsModal open={creditsOpen} onClose={() => setCreditsOpen(false)} />
    </>
  );
};

export default ConversationalVoiceButton;
