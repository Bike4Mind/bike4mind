import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useUser } from '@client/app/contexts/UserContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useVoiceSessionEngine } from '@client/app/components/Session/VoiceSessionModal/useVoiceSessionEngine';

interface UseVoiceStateParams {
  currentSessionId: string | null;
}

interface UseVoiceStateResult {
  spokenWords: number;
  setSpokenWords: (words: number) => void;
  isVoiceSessionEnabled: boolean;
  debugDrawerOpen: boolean;
  setDebugDrawerOpen: (open: boolean) => void;
  creditsExhaustedByVoice: boolean;
  // any: useVoiceSessionEngine return type is complex internal type
  voiceEngine: ReturnType<typeof useVoiceSessionEngine>;
}

export function useVoiceState({ currentSessionId }: UseVoiceStateParams): UseVoiceStateResult {
  const { currentUser, isDeveloper } = useUser();
  const { subscribeToAction } = useWebsocket();
  const adminEnableVoiceSession = useGetSettingsValue('enableVoiceSession');
  const voiceV2Enabled = useGetSettingsValue('voiceV2Enabled');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [spokenWords, setSpokenWords] = useState<number>(50);
  const [debugDrawerOpen, setDebugDrawerOpen] = useState(false);
  const [creditsExhaustedByVoice, setCreditsExhaustedByVoice] = useState(false);

  // The admin-only v1 session gives way to Voice v2 (ConversationalVoiceButton) when both are on, so
  // the composer never shows two voice-session buttons side by side.
  const isVoiceSessionEnabled = !!(adminEnableVoiceSession && !voiceV2Enabled && (currentUser?.isAdmin || isDeveloper));

  // Listen for server signal that voice session exhausted credits
  useEffect(() => {
    const unsubscribe = subscribeToAction('voice_credits_exhausted', async () => {
      setCreditsExhaustedByVoice(true);
    });
    return unsubscribe;
  }, [subscribeToAction]);

  const voiceEngine = useVoiceSessionEngine({
    sessionId: currentSessionId || undefined,
    onSessionCreated: newId => navigate({ to: `/notebooks/${newId}` }),
    onSessionEnded: () => {
      queryClient.invalidateQueries({ queryKey: ['quests'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  return {
    spokenWords,
    setSpokenWords,
    isVoiceSessionEnabled,
    debugDrawerOpen,
    setDebugDrawerOpen,
    creditsExhaustedByVoice,
    voiceEngine,
  };
}
