import type { IBriefcasePromptRepository } from '@bike4mind/common';

/**
 * Adapters injected into the briefcase service so the service holds policy
 * without a direct Mongoose import - testable with an in-memory fake. Mirrors
 * the dataLakeService seam.
 */
export interface BriefcaseServiceAdapters {
  db: {
    briefcasePrompts: Pick<
      IBriefcasePromptRepository,
      'listPersonal' | 'listSystemByType' | 'listSystemByTags' | 'findByIdForCaller'
    >;
  };
}
