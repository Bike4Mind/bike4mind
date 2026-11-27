import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { z } from 'zod';

const preferenceSchema = z.object({ sortByAttention: z.boolean() });

type PrAttentionSortPreference = {
  sortByAttention: boolean;
  setSortByAttention: (enabled: boolean) => void;
};

/** The sidebar's "needs attention" order; see groupSessions' `attentionRank`. Off by default. */
export const usePrAttentionSort = create<PrAttentionSortPreference>()(
  persist(set => ({ sortByAttention: false, setSortByAttention: enabled => set({ sortByAttention: enabled }) }), {
    name: 'b4m.sidebar.prAttentionSort',
    storage: createJSONStorage(() => localStorage),
    partialize: state => ({ sortByAttention: state.sortByAttention }),
    merge: (stored, current) => {
      const parsed = preferenceSchema.safeParse(stored);
      return parsed.success ? { ...current, ...parsed.data } : current;
    },
  })
);

export function prAttentionSortSummary(enabled: boolean): string {
  return enabled
    ? 'Sessions whose pull request needs you sit at the top of each group'
    : 'Off, sessions stay in order of recent activity';
}
