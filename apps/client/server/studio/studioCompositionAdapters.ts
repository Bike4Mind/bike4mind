import { fabFileRepository, projectRepository, studioCompositionRepository } from '@bike4mind/database';
import type { studioCompositionService } from '@bike4mind/services';

/** The production storage wiring for studioCompositionService, shared by the /api/studio/compositions routes. */
export const studioCompositionAdapters: studioCompositionService.StudioCompositionServiceAdapters = {
  db: { compositions: studioCompositionRepository, fabFiles: fabFileRepository, projects: projectRepository },
};
