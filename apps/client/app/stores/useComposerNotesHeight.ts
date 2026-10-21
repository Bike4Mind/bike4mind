import { create } from 'zustand';

interface ComposerNotesHeightState {
  /** px, including the gap under the notes; 0 when none show. */
  height: number;
  setHeight: (height: number) => void;
}

/**
 * Height of the account notes stacked above the composer's status line (SessionBottom). SessionMiddle's
 * scroll-to-bottom button hangs that much further down, so it still stops 16px above the composer
 * box instead of landing on a note.
 */
export const useComposerNotesHeight = create<ComposerNotesHeightState>(set => ({
  height: 0,
  setHeight: height => set({ height }),
}));
