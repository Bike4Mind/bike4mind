import { create } from 'zustand';
import type { TutorialTrack } from '@bike4mind/common';

interface TutorialPickerState {
  open: boolean;
  /** A track an entry point asked to start, taken up by the core host, which owns the transport and navigation. */
  requestedTrack: TutorialTrack | null;
  setOpen: (open: boolean) => void;
  requestTrack: (track: TutorialTrack) => void;
  clearTrackRequest: () => void;
}

/** Lets entry points outside the core host (welcome card, account menu) open the picker or start a track. */
export const useTutorialPicker = create<TutorialPickerState>(set => ({
  open: false,
  requestedTrack: null,
  setOpen: open => set({ open }),
  requestTrack: requestedTrack => set({ requestedTrack, open: false }),
  clearTrackRequest: () => set({ requestedTrack: null }),
}));
