import { tutorialModels } from './models';

// Its own module so the data-subject registry (apps/client/server/dataSubject/registry/content.ts)
// can register these models without loading the tutorial service and content.
export const coreModels = tutorialModels({ prefix: '', modelPrefix: 'Core' });
