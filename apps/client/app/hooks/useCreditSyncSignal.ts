import { create } from 'zustand';

/**
 * Bumped by `CreditBalanceSyncListener` when the last post-turn balance pull finishes, whether
 * or not the balance changed, so a held display can release once the live value is confirmed.
 */
export const useCreditSyncSignal = create<{ syncCount: number; markSynced: () => void }>(set => ({
  syncCount: 0,
  markSynced: () => set(state => ({ syncCount: state.syncCount + 1 })),
}));
