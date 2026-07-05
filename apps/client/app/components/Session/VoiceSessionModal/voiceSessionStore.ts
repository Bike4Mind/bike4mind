import { create } from 'zustand';

export interface VoiceSessionState {
  isMuted: boolean;
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  connectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  isEnding: boolean;
  setMuted: (muted: boolean) => void;
  setUserSpeaking: (speaking: boolean) => void;
  setAssistantSpeaking: (speaking: boolean) => void;
  setConnectionStatus: (status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void;
  setEnding: (ending: boolean) => void;
  reset: () => void;
}

export const useVoiceSessionStore = create<VoiceSessionState>(set => ({
  isMuted: false,
  userSpeaking: false,
  assistantSpeaking: false,
  connectionStatus: 'disconnected',
  isEnding: false,
  setMuted: muted => set({ isMuted: muted }),
  setUserSpeaking: speaking => set({ userSpeaking: speaking }),
  setAssistantSpeaking: speaking => set({ assistantSpeaking: speaking }),
  setConnectionStatus: status => set({ connectionStatus: status }),
  setEnding: ending => set({ isEnding: ending }),
  reset: () =>
    set({
      isMuted: false,
      userSpeaking: false,
      assistantSpeaking: false,
      connectionStatus: 'disconnected',
      isEnding: false,
    }),
}));
