import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { IResolvedPromptDispatch } from '@bike4mind/common';

interface ChatInputStore {
  // Current active session's input value (for real-time editing)
  chatInputValue: string;
  setChatInputValue: (value: string) => void;

  // Per-session draft storage (persisted to localStorage)
  drafts: Record<string, string>;
  setDraft: (sessionId: string, value: string) => void;
  getDraft: (sessionId: string) => string;
  clearDraft: (sessionId: string) => void;

  // Command history navigation state (uses notebook's actual chat history)
  historyIndex: number;
  tempInput: string; // Store current input when navigating history

  // Programmatic submit: set a prompt string that SessionBottom auto-sends
  programmaticSubmit: string | null;
  setProgrammaticSubmit: (prompt: string | null) => void;

  // Briefcase launch: a resolved one-click prompt dispatch that SessionBottom
  // auto-sends with per-message required tools. Distinct from programmaticSubmit
  // (a bare string) so the existing string consumers stay untouched.
  programmaticLaunch: IResolvedPromptDispatch | null;
  setProgrammaticLaunch: (dispatch: IResolvedPromptDispatch | null) => void;

  // Briefcase single-flight: shared across all launcher instances so every
  // launcher disables while any launch orchestration is in flight (a per-hook
  // flag would leave sibling launchers clickable-but-silently-dropped).
  briefcaseLaunchInFlight: boolean;
  setBriefcaseLaunchInFlight: (inFlight: boolean) => void;

  // Actions
  resetHistoryNavigation: () => void;
}

export const useChatInput = create<ChatInputStore>()(
  persist(
    (set, get) => ({
      chatInputValue: '',
      setChatInputValue: (value: string) => set({ chatInputValue: value }),

      // Per-session draft storage
      drafts: {},

      setDraft: (sessionId: string, value: string) => {
        if (!sessionId) return;
        set(state => ({
          drafts: {
            ...state.drafts,
            [sessionId]: value,
          },
        }));
      },

      getDraft: (sessionId: string) => {
        if (!sessionId) return '';
        return get().drafts[sessionId] || '';
      },

      clearDraft: (sessionId: string) => {
        if (!sessionId) return;
        set(state => {
          const { [sessionId]: _, ...remainingDrafts } = state.drafts;
          return { drafts: remainingDrafts };
        });
      },

      // Command history navigation state
      historyIndex: -1, // -1 means not navigating history
      tempInput: '',

      // Programmatic submit (consumed by SessionBottom)
      programmaticSubmit: null,
      setProgrammaticSubmit: (prompt: string | null) => set({ programmaticSubmit: prompt }),

      // Briefcase launch (consumed by SessionBottom's useSendMessage subscriber)
      programmaticLaunch: null,
      setProgrammaticLaunch: dispatch => set({ programmaticLaunch: dispatch }),

      // Briefcase single-flight (shared across launcher instances)
      briefcaseLaunchInFlight: false,
      setBriefcaseLaunchInFlight: inFlight => set({ briefcaseLaunchInFlight: inFlight }),

      // Reset history navigation (called when user types)
      resetHistoryNavigation: () => {
        set({ historyIndex: -1, tempInput: '' });
      },
    }),
    {
      name: 'chat-input-drafts',
      // Only persist the drafts, not the transient state
      partialize: state => ({ drafts: state.drafts }),
    }
  )
);
