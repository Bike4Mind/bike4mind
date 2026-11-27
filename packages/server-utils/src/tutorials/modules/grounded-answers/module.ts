import type { TutorialModuleIntro } from '../../types';
import { GROUNDED_ANSWERS_PROMPT } from './steps';
import { GROUNDED_ANSWERS_SHEET_CSV, GROUNDED_ANSWERS_SHEET_NAME } from './sheet';

export const groundedAnswersModule: TutorialModuleIntro = {
  id: 'grounded-answers',
  title: 'Answers from your files',
  pitch: 'Add a file to a notebook and get answers taken from it.',
  openingPrompt: GROUNDED_ANSWERS_PROMPT,
  sheet: { name: GROUNDED_ANSWERS_SHEET_NAME, csv: GROUNDED_ANSWERS_SHEET_CSV },
};
