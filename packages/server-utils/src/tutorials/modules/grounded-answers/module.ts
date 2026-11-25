import type { TutorialModuleIntro } from '../../types';
import { GROUNDED_ANSWERS_SHEET_CSV, GROUNDED_ANSWERS_SHEET_NAME } from './sheet';

export const groundedAnswersModule: TutorialModuleIntro = {
  id: 'grounded-answers',
  title: 'Answers from your files',
  pitch: 'Add a file to a notebook and get answers taken from it.',
  openingPrompt:
    'Using sample-team-faq.csv, how many vacation days do new staff get, and who approves them? Quote the line you used.',
  sheet: { name: GROUNDED_ANSWERS_SHEET_NAME, csv: GROUNDED_ANSWERS_SHEET_CSV },
};
