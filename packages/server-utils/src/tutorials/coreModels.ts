import { tutorialModels } from './models';

// Its own module so the data-subject walks (apps/client/server/dataSubject) can register these
// models without loading the tutorial service and content.
export const coreModels = tutorialModels({ prefix: '', modelPrefix: 'Core' });
