import type { TutorialStepRegistry } from '../types';
import { ModelSwitchStep } from './ModelSwitchStep';

/** Core's own step types, on top of the generic ones. */
export const CORE_TUTORIAL_STEPS: TutorialStepRegistry = { 'model-switch': ModelSwitchStep };
