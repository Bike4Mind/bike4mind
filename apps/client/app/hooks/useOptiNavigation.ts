import { create } from 'zustand';

/**
 * Zustand pub/sub store for opti family navigation.
 * NavigationButtons dispatches `requestFamily()`, OptiHashiPage consumes via `pendingFamily`.
 * Supports optional sub-tab deep-linking via `pendingSubTab`.
 */
interface OptiNavigationState {
  /** Family ID requested by navigation buttons (e.g., "scheduling") */
  pendingFamily: string | null;
  /** Optional sub-tab within the family (e.g., "solvers", "gantt") */
  pendingSubTab: string | null;
  /**
   * Prompt to send to the docked chat, dispatched by deck components
   * (FamilyConsole, PatternLearnTab, SchedulerTab). OptiHashiPage consumes it
   * via handleAskAbout, which creates the OptiHashi session first when none
   * is active - writing useChatInput.programmaticSubmit directly would be
   * silently dropped in that state (its consumers gate on a live session).
   */
  pendingPrompt: string | null;
  /** Request navigation to a specific opti family, optionally with a sub-tab */
  requestFamily: (familyId: string, subTab?: string) => void;
  /** Ask OptiHashiPage to send a prompt to the chat, creating a session if needed */
  requestChatPrompt: (prompt: string) => void;
  /** Clear pending family and sub-tab after OptiHashiPage consumes them */
  clearPending: () => void;
  /** Clear the pending chat prompt after OptiHashiPage consumes it */
  clearPendingPrompt: () => void;
}

export const useOptiNavigation = create<OptiNavigationState>(set => ({
  pendingFamily: null,
  pendingSubTab: null,
  pendingPrompt: null,
  requestFamily: (familyId: string, subTab?: string) => set({ pendingFamily: familyId, pendingSubTab: subTab ?? null }),
  requestChatPrompt: (prompt: string) => set({ pendingPrompt: prompt }),
  clearPending: () => set({ pendingFamily: null, pendingSubTab: null }),
  clearPendingPrompt: () => set({ pendingPrompt: null }),
}));
