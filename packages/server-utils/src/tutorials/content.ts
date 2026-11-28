import type { RepoTutorial } from './types';
import { firstStepsModule } from './modules/first-steps/module';
import { FIRST_STEPS_STEPS } from './modules/first-steps/steps';
import firstStepsTranscript from './modules/first-steps/transcript.json';
import { switchingModelsModule } from './modules/switching-models/module';
import { SWITCHING_MODELS_STEPS } from './modules/switching-models/steps';
import switchingModelsTranscript from './modules/switching-models/transcript.json';
import { groundedAnswersModule } from './modules/grounded-answers/module';
import { GROUNDED_ANSWERS_STEPS } from './modules/grounded-answers/steps';
import groundedAnswersTranscript from './modules/grounded-answers/transcript.json';
import { artifactsModule } from './modules/artifacts/module';
import { ARTIFACTS_STEPS } from './modules/artifacts/steps';
import artifactsTranscript from './modules/artifacts/transcript.json';
import { projectsModule } from './modules/projects/module';
import { PROJECTS_STEPS } from './modules/projects/steps';
import projectsTranscript from './modules/projects/transcript.json';
import { importHistoryModule } from './modules/import-history/module';
import { IMPORT_HISTORY_STEPS } from './modules/import-history/steps';
import importHistoryTranscript from './modules/import-history/transcript.json';

// Server-only, like the registry: the page gets a tutorial's content only from the run route, overrides applied.
export const CORE_TUTORIAL_CONTENT: readonly RepoTutorial[] = [
  { intro: firstStepsModule, version: 2, enabled: true, steps: FIRST_STEPS_STEPS, transcript: firstStepsTranscript },
  {
    intro: switchingModelsModule,
    version: 1,
    enabled: true,
    steps: SWITCHING_MODELS_STEPS,
    transcript: switchingModelsTranscript,
  },
  {
    intro: groundedAnswersModule,
    version: 1,
    enabled: true,
    steps: GROUNDED_ANSWERS_STEPS,
    transcript: groundedAnswersTranscript,
  },
  { intro: artifactsModule, version: 1, enabled: true, steps: ARTIFACTS_STEPS, transcript: artifactsTranscript },
  { intro: projectsModule, version: 1, enabled: true, steps: PROJECTS_STEPS, transcript: projectsTranscript },
  {
    intro: importHistoryModule,
    version: 1,
    enabled: true,
    steps: IMPORT_HISTORY_STEPS,
    transcript: importHistoryTranscript,
  },
];
