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
  /** A walk is being started or resumed: it holds the screen from the click until its first step shows. */
  launching: boolean;
  /** The recorded prompt the walk on screen waits for, when its step is a prompt step. */
  walkPrompt: string | null;
  /** The tour offer is on screen and unanswered: other first-run surfaces wait for it, as they do for a walk. */
  offerWaiting: boolean;
  /** The user took up or opened the offer this visit, so it no longer holds anything back. */
  offerAnswered: boolean;
  setOpen: (open: boolean) => void;
  requestTrack: (track: TutorialTrack) => void;
  clearTrackRequest: () => void;
  setHostState: (state: { hostMounted?: boolean; walkOnScreen?: boolean; walkPrompt?: string | null }) => void;
  setOfferWaiting: (offerWaiting: boolean) => void;
  setLaunching: (launching: boolean) => void;
  answerOffer: () => void;
}

/** Lets entry points outside the core host (welcome card, account menu) open the picker or start a track. */
export const useTutorialPicker = create<TutorialPickerState>(set => ({
  open: false,
  requestedTrack: null,
  hostMounted: false,
  walkOnScreen: false,
  launching: false,
  walkPrompt: null,
  offerWaiting: false,
  offerAnswered: false,
  setOpen: open => set({ open }),
  requestTrack: requestedTrack => set({ requestedTrack, open: false }),
  clearTrackRequest: () => set({ requestedTrack: null }),
  setHostState: state => set(state),
  setOfferWaiting: offerWaiting => set({ offerWaiting }),
  setLaunching: launching => set({ launching }),
  answerOffer: () => set({ offerAnswered: true, offerWaiting: false }),
}));
