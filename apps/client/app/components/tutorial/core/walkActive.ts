import { useTutorialPicker } from './tutorialPickerStore';

/**
 * True while a core tutorial walk shows on the open notebook, for first-run surfaces outside the host that must hold
 * back: the Gears discovery modal and the What's New slider. Light on purpose: no step renderers load with it.
 */
export const isCoreTutorialWalkActive = (): boolean => useTutorialPicker.getState().walkOnScreen;
