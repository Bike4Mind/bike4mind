import { samePrompt } from '@bike4mind/common';
import { CORE_TUTORIALS_API_BASE } from '../hostBase';
import { tutorialStoreFor } from '../useTutorialStore';
import { useTutorialPicker } from './tutorialPickerStore';

/**
 * The walk's notebook is the open route, but the host has not marked it on screen yet: the session is still being
 * fetched before it becomes current.
 */
const walkRouteOpening = (): boolean => {
  const active = tutorialStoreFor(CORE_TUTORIALS_API_BASE).getState().active;
  return active !== null && window.location.pathname === `/notebooks/${active.sessionId}`;
};

/**
 * True while a core tutorial walk shows on the open notebook, or is on its way there (a track asked for, a start or
 * resume in flight, its notebook still opening), for first-run surfaces outside the host that must hold back: the
 * Gears discovery modal and the What's New slider. Light on purpose: no step renderers load with it.
 */
export const isCoreTutorialWalkActive = (): boolean => {
  const { walkOnScreen, launching, requestedTrack } = useTutorialPicker.getState();
  return walkOnScreen || launching || requestedTrack !== null || walkRouteOpening();
};

/** True while the tour offer waits for an answer: it claims the first screen, so other first-run surfaces wait. */
export const isCoreTutorialOfferWaiting = (): boolean => useTutorialPicker.getState().offerWaiting;

/**
 * The walk on screen waits for exactly this message, which the server answers from the recording before any model
 * call or credit check. Anything else stays subject to the usual send checks.
 */
export const isRecordedTutorialTurn = (prompt: string): boolean => {
  const { walkOnScreen, walkPrompt } = useTutorialPicker.getState();
  return walkOnScreen && walkPrompt !== null && samePrompt(prompt, walkPrompt);
};
