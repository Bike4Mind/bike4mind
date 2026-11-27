import type { TutorialModuleIntro } from '../../types';
import { PROJECTS_PROMPT } from './steps';
import { PROJECTS_SHEET_CSV, PROJECTS_SHEET_NAME } from './sheet';

export const projectsModule: TutorialModuleIntro = {
  id: 'projects',
  title: 'Work in a project',
  pitch: 'Make a project, add a file to it, and ask about it.',
  openingPrompt: PROJECTS_PROMPT,
  sheet: { name: PROJECTS_SHEET_NAME, csv: PROJECTS_SHEET_CSV },
};
