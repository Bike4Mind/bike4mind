import { create } from 'zustand';

interface ScrollDebugState {
  active: boolean;
  toggle: () => void;
}

// Dev-only store for populating scrollable sections with dummy content to test scrollbar UX.
// Consumed by CombinedNotebooks (sidenav list) and SessionMiddle (chat history).
export const useScrollDebug = create<ScrollDebugState>(set => ({
  active: false,
  toggle: () => set(s => ({ active: !s.active })),
}));
