import { create } from 'zustand';

interface PendingLakeScopeState {
  /** Lake tags (`datalakeTag`), the spelling the create body wants. Empty = no pending choice. */
  lakeTags: string[];
  setLakeTags: (lakeTags: string[]) => void;
}

/**
 * A lake scope chosen on /new, where session creation is deferred to the first message so there
 * is nothing to persist it on yet (#3042).
 *
 * Mirrors useDataLakeMode, which carries the mode's on/off across the same gap; this carries
 * WHICH lakes. It exists because the picker (DataLakeExplorer) and the deferred-creation seam
 * (useCreateDataLakeSession, driven from useSendMessage) are in different trees, so the choice
 * cannot simply be lifted into a shared parent.
 *
 * Read at CREATE rather than written back afterwards: a follow-up PUT lands after the first
 * message has already been dispatched, so that reply would be grounded on every reachable lake -
 * the exact scope the user had just narrowed away from - and the narrowing would appear to have
 * silently failed for one turn.
 *
 * Cleared by whoever consumes it. Until then it outlives a navigation, the same lifetime
 * useDataLakeMode's flag has: a scope picked on /new is still pending on the next /new.
 */
export const usePendingLakeScope = create<PendingLakeScopeState>(set => ({
  lakeTags: [],
  setLakeTags: lakeTags => set({ lakeTags }),
}));
