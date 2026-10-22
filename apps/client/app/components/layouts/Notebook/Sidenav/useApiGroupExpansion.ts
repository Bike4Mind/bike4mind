import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface ApiGroupExpansionState {
  /** Date-bucket label (e.g. 'Today') -> expanded. Absent means collapsed, the default. */
  expanded: Record<string, boolean>;
  toggle: (bucketKey: string) => void;
}

/**
 * Which "API - N notebooks" groups (see apiGrouping.ts) are open, per date bucket. Kept in
 * sessionStorage: remembered for the tab's session, collapsed again in a new one.
 */
export const useApiGroupExpansion = create<ApiGroupExpansionState>()(
  persist(
    set => ({
      expanded: {},
      toggle: bucketKey => set(state => ({ expanded: { ...state.expanded, [bucketKey]: !state.expanded[bucketKey] } })),
    }),
    { name: 'sidenav-api-group-expansion', storage: createJSONStorage(() => sessionStorage) }
  )
);
