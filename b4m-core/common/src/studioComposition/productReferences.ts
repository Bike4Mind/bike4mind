import { IMAGE_JOB_INPUT_MIME_TYPES } from '../schemas/imageJobs';
import {
  STUDIO_COMPOSITION_LIMITS,
  type StudioBrandKit,
  type StudioCharacter,
  type StudioCompositionBrief,
  type StudioShot,
} from './composition';

/**
 * Every product file of a production, most authoritative first: the brief's product photo, then the brand kit's
 * product files (a saved product look sits at the front of those). The kit can also hold videos, so a shot narrows
 * this with productImageReferenceFileIds before referencing it. Duplicates are removed, so one file never takes two
 * reference slots.
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

/** 'checking' while the file's upload safety check runs; the image job refuses it until that turns clean. */
export type ReferenceImageState = 'ready' | 'checking';

/**
 * Whether an image job will take `file` as a reference image for `userId`, or null when it never will. Mirrors the
 * job's input gate (loadInputFabFile in packages/server-utils generationJobs/wiring.ts, and createImageJobs'
 * mime check) and must stay in sync with it: owner only, not deleted, PNG/JPEG/WebP, not blocked by moderation.
 */
export const referenceImageState = (
  file: {
    userId?: unknown;
    deletedAt?: Date | null;
    mimeType?: string | null;
    filePath?: string | null;
    moderationStatus?: string | null;
  },
  userId: string
): ReferenceImageState | null => {
  // A stored userId may be an ObjectId or a string.
  if (file.userId == null || String(file.userId) !== userId || file.deletedAt || !file.filePath) return null;
  const mimeType = file.mimeType?.split(';')[0].trim().toLowerCase();
  if (!mimeType || !IMAGE_JOB_INPUT_MIME_TYPES.has(mimeType)) return null;
  if (file.moderationStatus === 'clean') return 'ready';
  return file.moderationStatus === 'pending' || file.moderationStatus === 'scanning' ? 'checking' : null;
};

/**
 * productReferenceFileIds narrowed to the files an image job will take as references (see referenceImageState):
 * `usable` holds those, and anything missing from it (a video, a shared or deleted file, an unsupported format) is
 * dropped. Filter before slicing to a model's cap, so an unusable file never takes the one slot a single-reference
 * model has.
 */
export const productImageReferenceFileIds = (
  content: Parameters<typeof productReferenceFileIds>[0],
  usable: { has(id: string): boolean }
): string[] => productReferenceFileIds(content).filter(id => usable.has(id));

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

/** The kit characters a shot features, in the shot's order. An id no longer in the kit is skipped. */
export const shotCharacters = (
  shot: Pick<StudioShot, 'characterIds'>,
  characters: readonly StudioCharacter[]
): StudioCharacter[] => {
  const ids = [...new Set(shot.characterIds ?? [])];
  return ids.flatMap(id => characters.filter(character => character.id === id));
};

export type ShotReferenceSelection = {
  fileIds: string[];
  characters: StudioCharacter[];
  droppedCharacters: StudioCharacter[];
};

/**
 * One shot's reference images cut to a model's cap: the product look, then the shot's characters in order, then the
 * other product images. A single-reference model keeps the product; a second slot goes to a character before another
 * product angle. A character sharing a file already taken is kept without spending a slot.
 */
export const selectShotReferences = (
  references: { productFileIds: readonly string[]; characters: readonly StudioCharacter[] },
  maxReferences: number
): ShotReferenceSelection => {
  const [look, ...otherProducts] = references.productFileIds;
  const fileIds: string[] = [];
  const take = (fileId: string): boolean => {
    if (fileIds.includes(fileId)) return true;
    if (fileIds.length >= maxReferences) return false;
    fileIds.push(fileId);
    return true;
  };
  if (look) take(look);
  const characters: StudioCharacter[] = [];
  const droppedCharacters: StudioCharacter[] = [];
  for (const character of references.characters) {
    (take(character.fileId) ? characters : droppedCharacters).push(character);
  }
  for (const fileId of otherProducts) take(fileId);
  return { fileIds, characters, droppedCharacters };
};
