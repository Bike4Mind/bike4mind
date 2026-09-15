import type { IImageGenerationTemplateRepository } from '@bike4mind/common';

/**
 * Adapters injected into the image-template service so the service holds policy
 * without a direct Mongoose import - testable with an in-memory fake. Mirrors
 * the briefcaseService seam.
 */
export interface ImageTemplateServiceAdapters {
  db: {
    templates: IImageGenerationTemplateRepository;
  };
}
