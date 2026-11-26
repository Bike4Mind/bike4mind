import type { TutorialStepRegistry } from '../types';
import { ArtifactOpenStep } from './ArtifactOpenStep';
import { ModelSwitchStep } from './ModelSwitchStep';

/** Core's own step types, on top of the generic ones. */
export const CORE_TUTORIAL_STEPS: TutorialStepRegistry = {
  'artifact-open': ArtifactOpenStep,
  'model-switch': ModelSwitchStep,
};
