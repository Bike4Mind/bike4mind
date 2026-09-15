import { CircularProgress, IconButton, Tooltip } from '@mui/joy';
import { CallEnd, GraphicEq } from '@mui/icons-material';
import React, { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useConversationalVoiceStore } from './useConversationalVoice';

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
    <Tooltip
      title={isReconnecting ? 'Reconnecting…' : isActive ? 'End voice call' : 'Voice (v2 — any model)'}
      placement="top"
    >
      <IconButton
        size="sm"
        variant={isActive ? 'solid' : 'outlined'}
        color={isActive ? 'danger' : 'neutral'}
        onClick={handleClick}
        data-testid="conversational-voice-btn"
      >
        {isBusy ? <CircularProgress size="sm" /> : isActive ? <CallEnd /> : <GraphicEq />}
      </IconButton>
    </Tooltip>
  );
};

export default ConversationalVoiceButton;
