import { Box, CircularProgress, IconButton, Tooltip, Typography } from '@mui/joy';
import { CallEnd, GraphicEq } from '@mui/icons-material';
import React, { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { estimateElevenLabsConversationalCost } from '@bike4mind/voice';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useUser } from '@client/app/contexts/UserContext';
import CreditsModal from '@client/app/components/subscription/CreditsModal';
import { MAX_SESSION_SECONDS } from '@server/voice/voiceSessionLimits';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import { useConversationalVoiceStore } from './useConversationalVoice';

// Same pricing POST /api/voice/v2/sessions reserves against and /end bills pro rata per second,
// so the hint cannot drift from what a call costs.
const CREDITS_PER_MINUTE = estimateElevenLabsConversationalCost(60).creditsToReserve;
const VOICE_COST_HINT = `About ${CREDITS_PER_MINUTE.toLocaleString('en-US')} credits/min, billed by the second`;
// The up-front hold POST /api/voice/v2/sessions takes (unused credits are refunded on end).
const HOLD_CREDITS = estimateElevenLabsConversationalCost(MAX_SESSION_SECONDS).creditsToReserve;
const VOICE_HOLD_HINT = `Needs ${HOLD_CREDITS.toLocaleString('en-US')} credits to start; unused credits are refunded`;
const START_LABEL = 'Voice (v2 \u2014 any model)';

export interface ConversationalVoiceButtonProps {
  currentSessionId: string | null;
  reasoningModelId?: string;
}

/**
 * Single toolbar control for Voice v2 - no modal. Click to start a call; while
 * a call is active the button turns red and clicking it ends the call. The
 * conversation itself renders in the notebook (ChatCompletionProcess streams
 * each turn as a quest), so there's no separate UI surface to show.
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
  const errorMessage = useConversationalVoiceStore(s => s.errorMessage);
  const start = useConversationalVoiceStore(s => s.start);
  const end = useConversationalVoiceStore(s => s.end);
  const costHintId = useId();
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const { currentUser } = useUser();
  const [creditsOpen, setCreditsOpen] = useState(false);
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

  const isReconnecting = phase === 'reconnecting';
  const isBusy = phase === 'requesting-session' || phase === 'connecting' || isReconnecting;
  const isActive = isBusy || phase === 'connected';

  const handleClick = () => {
    if (isActive) {
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

  const buttonLabel = isReconnecting ? 'Reconnecting…' : isActive ? 'End voice call' : START_LABEL;
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
      {/* describeChild: with a node title Joy would otherwise point aria-labelledby at the tooltip while
          open, so the hint was announced as part of the name and again as the description. Joy then no
          longer derives aria-label from a string title, so the button carries its own label in every state. */}
      <Tooltip title={isActive ? buttonLabel : idleTitle} placement="top" describeChild>
        <IconButton
          size="sm"
          variant={isActive ? 'solid' : 'outlined'}
          color={isActive ? 'danger' : 'neutral'}
          onClick={handleClick}
          data-testid="conversational-voice-btn"
          aria-label={buttonLabel}
          aria-describedby={isActive ? undefined : costHintId}
        >
          {isBusy ? <CircularProgress size="sm" /> : isActive ? <CallEnd /> : <GraphicEq />}
          {!isActive && (
            <Box component="span" id={costHintId} sx={visuallyHidden}>
              {hint}
            </Box>
          )}
        </IconButton>
      </Tooltip>
      <CreditsModal open={creditsOpen} onClose={() => setCreditsOpen(false)} />
    </>
  );
};

export default ConversationalVoiceButton;
