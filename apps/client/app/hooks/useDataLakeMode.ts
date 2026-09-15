import { create } from 'zustand';

interface DataLakeModeSessionLike {
  id?: string;
  forceKnowledgeRetrieval?: boolean;
}

interface DataLakeModeState {
  /** Whether Data Lake mode is on for the currently-viewed chat. */
  enabled: boolean;
  /** The session id `enabled` was last seeded from, so re-renders of the same session
   *  don't clobber a local toggle. */
  seededSessionId: string | null;
  setEnabled: (enabled: boolean) => void;
  seedFromSession: (session: DataLakeModeSessionLike | null) => void;
  reset: () => void;
}

const useDataLakeMode = create<DataLakeModeState>(set => ({
  enabled: false,
  seededSessionId: null,
  setEnabled: enabled => set({ enabled }),
  seedFromSession: session => {
    if (!session?.id) {
      // /new (no session yet): PRESERVE the toggle so a Data-Lake-on new chat (or a quick
      // pre-select that routes through /new) keeps the tree open - the first send then creates
      // the grounded session (see useSetDataLakeMode). Only clear the seeded-id so the created
      // session re-seeds cleanly; resetting `enabled` here was what closed the sidebar.
      set({ seededSessionId: null });
      return;
    }
    set(state =>
      state.seededSessionId === session.id
        ? state
        : { ...state, seededSessionId: session.id, enabled: !!session.forceKnowledgeRetrieval }
    );
  },
  reset: () => set({ enabled: false, seededSessionId: null }),
}));

export default useDataLakeMode;
