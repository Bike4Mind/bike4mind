import { create } from 'zustand';

/**
 * Zustand pub/sub store for cross-component session switching.
 *
 * The sidebar dispatches `requestSession(id)` when the user clicks a notebook
 * while on a "session-hosting" route (e.g. /opti). The hosting route consumes
 * `pendingSessionId` and switches its floating chat to that session - no
 * route navigation occurs.
 *
 * This is the session-switching counterpart of `useOptiNavigation` (which
 * handles dashboard family/tab navigation). Together they let the sidebar
 * and LLM tools communicate intentions to /opti without hard navigations.
 *
 * Generalizable: any future route that hosts a floating session can subscribe
 * to this same store and intercept sidebar clicks the same way.
 */
interface SessionRouterState {
  /** Session ID requested by the sidebar (consumed by the hosting route) */
  pendingSessionId: string | null;
  /** Request the hosting route to switch to a specific session */
  requestSession: (sessionId: string) => void;
  /** Clear after the hosting route has consumed the request */
  clearPending: () => void;

  /**
   * Factory the hosting route registers to create a NEW session of its own kind
   * (e.g. /opti's server-treated session via its premium session-create endpoint),
   * optionally seeding a first prompt. Two consumers:
   *   1. A dedicated sidebar's "New Chat" button calls it with no prompt.
   *   2. `useSendMessage` calls it (with the prompt) when a first message is sent
   *      with no active session - so the message lands in a properly-treated session
   *      instead of the generic `getOrCreateSession` path, which would stamp
   *      `surface: null` and orphan the notebook from the surface's scoped nav.
   * Null when no host route is mounted (the sidebar/guard then no-op or fall back).
   */
  hostCreateSession: ((prompt?: string) => Promise<void>) | null;
  /** Register (or clear, with null) the host's session factory. */
  setHostCreateSession: (factory: ((prompt?: string) => Promise<void>) | null) => void;
}

export const useSessionRouter = create<SessionRouterState>(set => ({
  pendingSessionId: null,
  requestSession: (sessionId: string) => set({ pendingSessionId: sessionId }),
  clearPending: () => set({ pendingSessionId: null }),

  hostCreateSession: null,
  setHostCreateSession: factory => set({ hostCreateSession: factory }),
}));
