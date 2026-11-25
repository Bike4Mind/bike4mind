import type { RepoTutorial } from './types';
import { firstStepsModule } from './modules/first-steps/module';
import { FIRST_STEPS_STEPS } from './modules/first-steps/steps';
import firstStepsTranscript from './modules/first-steps/transcript.json';
import { groundedAnswersModule } from './modules/grounded-answers/module';
import { GROUNDED_ANSWERS_STEPS } from './modules/grounded-answers/steps';
import groundedAnswersTranscript from './modules/grounded-answers/transcript.json';

// Server-only, like the registry: the page gets a tutorial's content only from the run route, overrides applied.
export const CORE_TUTORIAL_CONTENT: readonly RepoTutorial[] = [
  { intro: firstStepsModule, version: 1, enabled: true, steps: FIRST_STEPS_STEPS, transcript: firstStepsTranscript },
  {
    intro: groundedAnswersModule,
    version: 1,
    enabled: true,
    steps: GROUNDED_ANSWERS_STEPS,
    transcript: groundedAnswersTranscript,
  },
];
