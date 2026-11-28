import type { TutorialModuleIntro } from '../../types';
import { IMPORT_HISTORY_PROMPT } from './steps';

// No sample sheet: the importer takes a .zip from the learner's own device, which a seeded file cannot reach.
export const importHistoryModule: TutorialModuleIntro = {
  id: 'import-history',
  title: 'Bring your chat history',
  pitch: 'Move your past chats from ChatGPT or Claude into notebooks here.',
  openingPrompt: IMPORT_HISTORY_PROMPT,
};
