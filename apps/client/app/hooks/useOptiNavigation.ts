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
   * True only when the request came from someone clicking a navigate_view button.
   * Consumers need it because they cannot tell a click apart by their own state: the
   * click writes this store before its navigation commits, so the consumer still sees
   * the view being left.
   *
   * False is NOT the same as "replayed on session load" - it also covers the live
   * follow-to-console after a just-completed formulate/solve, because that path
   * dispatches from a mount effect and cannot distinguish a fresh reply from a
   * persisted one. A consumer that drops everything with `!pendingUserInitiated`
   * therefore kills the intended live follow too; gate on the effect's own
   * freshness for that, and use this flag only to force a click through.
   */
  pendingUserInitiated: boolean;
  /**
   * Prompt to send to the docked chat, dispatched by deck components
   * (FamilyConsole, PatternLearnTab, SchedulerTab). OptiHashiPage consumes it
   * via handleAskAbout, which creates the OptiHashi session first when none
   * is active - writing useChatInput.programmaticSubmit directly would be
   * silently dropped in that state (its consumers gate on a live session).
   */
  pendingPrompt: string | null;
  /**
   * Set by a surface that renders the requested family console INSIDE its own
   * pane and owns the way back out of it. While it holds, the executor dispatches
   * the request and leaves `?mode=` alone - naming the standalone console view
   * would unmount that surface mid-click, which is how the user ends up somewhere
   * with no route back to what they were looking at.
   *
   * A registration, not part of a request: `clearPending` leaves it standing, and
   * the surface clears it when it unmounts.
   */
  hostHandlesFamilyInPlace: boolean;
  /** Register (or clear, with false) the host's in-place console claim. */
  setHostHandlesFamilyInPlace: (handles: boolean) => void;
  /** Request navigation to a specific opti family, optionally with a sub-tab */
  requestFamily: (familyId: string, subTab?: string, opts?: { userInitiated?: boolean }) => void;
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
  pendingUserInitiated: false,
  pendingPrompt: null,
  hostHandlesFamilyInPlace: false,
  setHostHandlesFamilyInPlace: (handles: boolean) => set({ hostHandlesFamilyInPlace: handles }),
  requestFamily: (familyId: string, subTab?: string, opts?: { userInitiated?: boolean }) =>
    set({ pendingFamily: familyId, pendingSubTab: subTab ?? null, pendingUserInitiated: opts?.userInitiated === true }),
  requestChatPrompt: (prompt: string) => set({ pendingPrompt: prompt }),
  clearPending: () => set({ pendingFamily: null, pendingSubTab: null, pendingUserInitiated: false }),
  clearPendingPrompt: () => set({ pendingPrompt: null }),
}));
