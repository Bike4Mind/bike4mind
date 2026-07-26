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
      set({ enabled: false, seededSessionId: null });
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
