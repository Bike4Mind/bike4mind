import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { z } from 'zod';

const preferenceSchema = z.object({ showDollarCosts: z.boolean() });

type CostDisplayPreference = {
  showDollarCosts: boolean;
  setShowDollarCosts: (enabled: boolean) => void;
};

export const useCostDisplayPreference = create<CostDisplayPreference>()(
  persist(set => ({ showDollarCosts: false, setShowDollarCosts: enabled => set({ showDollarCosts: enabled }) }), {
    name: 'b4m.chat.costDisplay',
    storage: createJSONStorage(() => localStorage),
    partialize: state => ({ showDollarCosts: state.showDollarCosts }),
    merge: (stored, current) => {
      const parsed = preferenceSchema.safeParse(stored);
      return parsed.success ? { ...current, ...parsed.data } : current;
    },
  })
);

export function useShowDollarCosts(): boolean {
  const enabled = useCostDisplayPreference(state => state.showDollarCosts);
  // A saved development preference must never enable dollars in a customer build.
  return import.meta.env.DEV && enabled;
}
