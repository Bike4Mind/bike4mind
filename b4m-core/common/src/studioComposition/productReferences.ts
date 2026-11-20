import { STUDIO_COMPOSITION_LIMITS, type StudioBrandKit, type StudioCompositionBrief } from './composition';

/**
 * The product images every shot of a production is generated against, most authoritative first: the brief's
 * product photo, then the brand kit's product images (a saved product look sits at the front of those).
 * Order matters because several image models take a single reference (Gemini, FLUX 1.x Pro), and a caller
 * slices this list to the model's cap. Ids are lowercased, as the image-job API sends them, so one file never
 * takes two reference slots.
 */
export const productReferenceFileIds = (content: {
  brief: Pick<StudioCompositionBrief, 'productFileId'>;
  brandKit: Pick<StudioBrandKit, 'productFileIds'>;
}): string[] => {
  const ids = [
    ...(content.brief.productFileId ? [content.brief.productFileId] : []),
    ...content.brandKit.productFileIds,
  ];
  return [...new Set(ids.map(fileId => fileId.toLowerCase()))];
};

/**
 * Saves `fileId` as the production's product look: moved to the front of the brand kit's product images, so
 * every later shot references it ahead of the other product images. Keeps the list within its cap by dropping
 * from the end.
 */
export const withProductLook = (productFileIds: readonly string[], fileId: string): string[] =>
  [fileId, ...productFileIds.filter(id => id !== fileId)].slice(0, STUDIO_COMPOSITION_LIMITS.brandProductFilesMax);
