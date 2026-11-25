import { create } from 'zustand';
import type { TutorialTrack } from '@bike4mind/common';

interface TutorialPickerState {
  open: boolean;
  /** A track an entry point asked to start, taken up by the core host, which owns the transport and navigation. */
  requestedTrack: TutorialTrack | null;
  /** The core host is mounted here, so the picker and its entry points can act. Admin pages mount none. */
  hostMounted: boolean;
  /** A core walk shows on the open notebook: other first-run surfaces hold back while it does. */
  walkOnScreen: boolean;
  setOpen: (open: boolean) => void;
  requestTrack: (track: TutorialTrack) => void;
  clearTrackRequest: () => void;
  setHostState: (state: { hostMounted?: boolean; walkOnScreen?: boolean }) => void;
}

/** Lets entry points outside the core host (welcome card, account menu) open the picker or start a track. */
export const useTutorialPicker = create<TutorialPickerState>(set => ({
  open: false,
  requestedTrack: null,
  hostMounted: false,
  walkOnScreen: false,
  setOpen: open => set({ open }),
  requestTrack: requestedTrack => set({ requestedTrack, open: false }),
  clearTrackRequest: () => set({ requestedTrack: null }),
  setHostState: state => set(state),
}));
