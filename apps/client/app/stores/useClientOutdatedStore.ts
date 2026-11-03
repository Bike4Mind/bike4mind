import { create } from 'zustand';

type ClientOutdatedState = {
  /** True once an API response named a revision other than the one this page load started on. */
  outdated: boolean;
  markOutdated: () => void;
};

export const useClientOutdatedStore = create<ClientOutdatedState>(set => ({
  outdated: false,
  markOutdated: () => set({ outdated: true }),
}));
