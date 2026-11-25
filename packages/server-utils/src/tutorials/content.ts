import type { RepoTutorial } from './types';
import { firstStepsModule } from './modules/first-steps/module';
import { FIRST_STEPS_STEPS } from './modules/first-steps/steps';
import firstStepsTranscript from './modules/first-steps/transcript.json';

// Server-only, like the registry: the page gets a tutorial's content only from the run route, overrides applied.
export const CORE_TUTORIAL_CONTENT: readonly RepoTutorial[] = [
  { intro: firstStepsModule, version: 1, enabled: true, steps: FIRST_STEPS_STEPS, transcript: firstStepsTranscript },
];
