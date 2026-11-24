import { STUDIO_COMPOSITION_LIMITS, type StudioBrandKit, type StudioCompositionBrief } from './composition';
import type { StudioFileMediaKind } from './validateTimeline';

/**
 * The product images every shot of a production is generated against, most authoritative first: the brief's
 * product photo, then the brand kit's product images (a saved product look sits at the front of those).
 * Order matters because several image models take a single reference (Gemini, FLUX 1.x Pro), and a caller
 * slices this list to the model's cap. Duplicates are removed, so one file never takes two reference slots.
 */
export const productReferenceFileIds = (content: {
  brief: Pick<StudioCompositionBrief, 'productFileId'>;
  brandKit: Pick<StudioBrandKit, 'productFileIds'>;
}): string[] => {
  const ids = [
    ...(content.brief.productFileId ? [content.brief.productFileId] : []),
    ...content.brandKit.productFileIds,
  ];
  return [...new Set(ids)];
};

/**
 * productReferenceFileIds narrowed to images, the only kind an image model takes as a reference. The brand kit also
 * holds product videos, and a file missing from `fileKinds` (deleted, unshared, unknown) is dropped too. Filter before
 * slicing to a model's cap, so a video never takes the one slot a single-reference model has.
 */
export const productImageReferenceFileIds = (
  content: Parameters<typeof productReferenceFileIds>[0],
  fileKinds: ReadonlyMap<string, StudioFileMediaKind>
): string[] => productReferenceFileIds(content).filter(id => fileKinds.get(id) === 'image');

/**
 * Moves `fileId` to the front of the brand kit's product images, making it the production's product look.
 * Keeps the list within its cap by dropping from the end.
 */
export const withProductLook = (productFileIds: readonly string[], fileId: string): string[] =>
  [fileId, ...productFileIds.filter(id => id !== fileId)].slice(0, STUDIO_COMPOSITION_LIMITS.brandProductFilesMax);

/**
 * Adds the director's storyboard product photo to the brand kit's product images. The product look the user keeps
 * at the front (picked in the Brand kit panel) stays first, so the photo lands second and a single-reference model
 * still uses that look; with no images yet the photo becomes the look. A photo already in the list is not moved.
 */
export const withDirectorProduct = (productFileIds: readonly string[], fileId: string): string[] => {
  if (productFileIds.includes(fileId)) return [...productFileIds];
  if (productFileIds.length === 0) return withProductLook(productFileIds, fileId);
  return withProductLook(withProductLook(productFileIds, fileId), productFileIds[0]);
};
