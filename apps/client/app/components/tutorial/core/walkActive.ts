import { CORE_TUTORIALS_API_BASE } from '../hostBase';
import { tutorialStoreFor } from '../useTutorialStore';

/**
 * True while a core tutorial walk runs, for first-run surfaces outside React (or outside the host) that must hold
 * back: the Gears discovery modal and the What's New slider. Light on purpose: no step renderers load with it.
 */
export const isCoreTutorialWalkActive = (): boolean =>
  tutorialStoreFor(CORE_TUTORIALS_API_BASE).getState().active !== null;
