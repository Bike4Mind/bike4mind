import {
  SkillListingTemplate,
  adminSettingsRepository,
  dataLakeRepository,
  fabFileRepository,
  organizationRepository,
  questRepository,
  sessionRepository,
  User,
} from '@bike4mind/database';
import {
  BadRequestError,
  ConflictError,
  GENERATED_IMAGE_EXTENSION_RE,
  ImageModels,
  KnowledgeType,
  NotFoundError,
  SKILL_TEMPLATE_IMAGE_HEIGHT,
  SKILL_TEMPLATE_IMAGE_SOURCE_MAX_BYTES,
  SKILL_TEMPLATE_IMAGE_SOURCE_MIME_TYPES,
  SKILL_TEMPLATE_IMAGE_WIDTH,
  isImageServeable,
  skillTemplateFreeRunEligibility,
  type ISkillListing,
  type ISkillListingTemplate,
  type ISkillTemplatePreviewImage,
  type SkillListingVisibility,
  type SkillTemplateEditorView,
  type SkillTemplatePreviewImageStatus,
} from '@bike4mind/common';
import { findListing, type MarketActor } from '@bike4mind/server-utils/skillMarket/market';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { storageReadOverrides } from '@bike4mind/utils/contentDisposition';
import { coverImageToJpeg, ImageDecodeError } from '@bike4mind/utils/imageResize';
import {
  approvedSnapshotOf,
  isLive,
  plainTemplate,
  requireDraftTemplate,
  requireOwnListing,
  suggestTemplateSlug,
} from './template';
import { exampleRunsLeftToday } from './templateExampleCap';

/**
 * The template preview image: one 1200x630 JPEG per template, stored as a file the author owns. A
 * new image always starts unapproved, and it only changes while the template is a draft.
 */

/** FLUX Ultra is the app's default image model; 16:9 is its common ratio nearest the 1.91:1 card. */
export const TEMPLATE_IMAGE_MODEL = ImageModels.FLUX_PRO_ULTRA;
export const TEMPLATE_IMAGE_ASPECT_RATIO = '16:9';

/** Only these listings have a page a logged-out link-preview fetcher may see. */
const PUBLIC_PAGE_VISIBILITY: ReadonlySet<SkillListingVisibility> = new Set(['public', 'unlisted']);

const EDITOR_IMAGE_URL_TTL_SECONDS = 3600;
const STORED_MIME_TYPE = 'image/jpeg';

export interface TemplateImageDeps {
  /** Bytes of a files-bucket object. */
  readFile: (key: string) => Promise<Buffer>;
  /** Bytes of a generated-images-bucket object (a `quest.images` name). */
  readGeneratedImage: (key: string) => Promise<Buffer>;
  /** Exactly SKILL_TEMPLATE_IMAGE_WIDTH x SKILL_TEMPLATE_IMAGE_HEIGHT, as JPEG. */
  normalize: (bytes: Buffer) => Promise<Buffer>;
  /** Stores the normalized image as a new file owned by `userId` and returns its id. */
  storeImage: (userId: string, bytes: Buffer, fileName: string) => Promise<string>;
  /** A short-lived browser URL for a files-bucket key. */
  signFileUrl: (key: string, mimeType: string) => Promise<string>;
}

async function storeTemplateImageFile(userId: string, bytes: Buffer, fileName: string): Promise<string> {
  const { fabFilesService } = await import('@bike4mind/services');
  // The size cap and the owner's storage quota are checked inside createFabFile.
  const file = await fabFilesService.createFabFile(
    userId,
    {
      fileName,
      mimeType: STORED_MIME_TYPE,
      contentType: STORED_MIME_TYPE,
      fileSize: bytes.length,
      type: KnowledgeType.FILE,
      content: bytes,
    },
    {
      db: {
        adminSettings: adminSettingsRepository,
        fabFiles: fabFileRepository,
        users: User,
        organizations: organizationRepository,
        dataLakes: dataLakeRepository,
      },
      storage: {
        upload: (path, content, options) =>
          getFilesStorage().upload(content, path, { ContentType: options?.ContentType ?? STORED_MIME_TYPE }),
        generateSignedUrl: (path, expiresIn, mode, options) =>
          getFilesStorage().getSignedUrl(path, mode ?? 'get', { expiresIn, ...options }),
      },
    }
  );
  return file.id;
}

export const templateImageDeps = (): TemplateImageDeps => ({
  readFile: key => getFilesStorage().download(key),
  readGeneratedImage: key => getGeneratedImageStorage().download(key),
  normalize: bytes =>
    coverImageToJpeg(bytes, { width: SKILL_TEMPLATE_IMAGE_WIDTH, height: SKILL_TEMPLATE_IMAGE_HEIGHT }),
  storeImage: storeTemplateImageFile,
  signFileUrl: (key, mimeType) =>
    getFilesStorage().getSignedUrl(key, 'get', {
      expiresIn: EDITOR_IMAGE_URL_TTL_SECONDS,
      audience: 'browser',
      ...storageReadOverrides({ mimeType, key }),
    }),
});

const bareMimeType = (mimeType: string | null | undefined) => (mimeType ?? '').split(';')[0].trim().toLowerCase();

const tooLarge = () =>
  new BadRequestError(`The image must be ${SKILL_TEMPLATE_IMAGE_SOURCE_MAX_BYTES / (1024 * 1024)} MB or smaller`);

type ImageFile = { filePath: string; mimeType: string; moderationStatus?: string | null };

/** The file behind a preview image, if `ownerId` still owns it. */
async function ownedFile(fabFileId: string, ownerId: string): Promise<ImageFile | null> {
  const file = await fabFileRepository.findById(fabFileId);
  if (!file || file.userId !== ownerId || file.deletedAt || !file.filePath) return null;
  return { filePath: file.filePath, mimeType: file.mimeType, moderationStatus: file.moderationStatus };
}

function imageStatus(file: ImageFile | null): SkillTemplatePreviewImageStatus {
  if (!file) return 'missing';
  if (file.moderationStatus === 'blocked') return 'blocked';
  return isImageServeable(file) ? 'ready' : 'pending';
}

async function normalizeImage(bytes: Buffer, deps: TemplateImageDeps): Promise<Buffer> {
  if (bytes.length > SKILL_TEMPLATE_IMAGE_SOURCE_MAX_BYTES) throw tooLarge();
  try {
    return await deps.normalize(bytes);
  } catch (error) {
    if (error instanceof ImageDecodeError) throw new BadRequestError('The image could not be read. Use a PNG or JPEG.');
    throw error;
  }
}

/** Normalize, store and attach a new, unapproved preview image to the author's draft template. */
async function attachImage(
  listingId: string,
  ownerId: string,
  slug: string,
  bytes: Buffer,
  source: ISkillTemplatePreviewImage['source'],
  deps: TemplateImageDeps
): Promise<ISkillListingTemplate> {
  const normalized = await normalizeImage(bytes, deps);
  const fabFileId = await deps.storeImage(ownerId, normalized, `${slug}-preview.jpg`);
  const previewImage: ISkillTemplatePreviewImage = { fabFileId, source, approved: false };
  const updated = await SkillListingTemplate.findOneAndUpdate(
    { listingId, status: 'draft' },
    { $set: { previewImage } },
    { new: true, runValidators: true }
  );
  if (!updated) throw new ConflictError('The template changed while saving. Reload and try again.');
  return plainTemplate(updated);
}

const isMissingObject = (error: unknown): boolean => {
  const e = error as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    e?.name === 'NoSuchKey' ||
    e?.Code === 'NoSuchKey' ||
    e?.code === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
};

/** Use a screenshot the author uploaded (a file they own) as the preview image. */
export async function setOwnTemplateImageFromUpload(
  user: MarketActor,
  listingId: string,
  fabFileId: string,
  deps: TemplateImageDeps = templateImageDeps()
): Promise<ISkillListingTemplate> {
  const { listing, template } = await requireDraftTemplate(user, listingId, { live: true });
  const file = await fabFileRepository.findById(fabFileId);
  if (!file || file.userId !== user.id || file.deletedAt || !file.filePath) throw new NotFoundError('File not found');
  if (!SKILL_TEMPLATE_IMAGE_SOURCE_MIME_TYPES.includes(bareMimeType(file.mimeType))) {
    throw new BadRequestError('Upload a PNG or JPEG image');
  }
  if (file.moderationStatus === 'blocked') throw new BadRequestError('This image cannot be used. Choose another one.');
  if (file.fileSize > SKILL_TEMPLATE_IMAGE_SOURCE_MAX_BYTES) throw tooLarge();
  const bytes = await deps.readFile(file.filePath).catch((error: unknown) => {
    if (isMissingObject(error)) throw new ConflictError('The upload has not finished yet. Try again in a moment.');
    throw error;
  });
  return attachImage(String(listing.id), user.id, template.slug, bytes, 'upload', deps);
}

export function buildTemplateImagePrompt(headline: string, result: string): string {
  return [
    'A clean, modern preview image in a wide landscape layout, showing the finished result below ' +
      'as a polished document or app screen.',
    'Keep any text short and legible. No logos, no watermarks, no people.',
    `What the result is: ${headline.trim()}`,
    'The result:',
    result,
  ].join('\n\n');
}

/** The prompt and notebook name for a preview image generation; the route runs it as the author's own. */
export async function prepareTemplateImageGeneration(
  user: MarketActor,
  listingId: string,
  result: string
): Promise<{ prompt: string; sessionName: string }> {
  const { listing, template } = await requireDraftTemplate(user, listingId, { live: true });
  if (!template.headline.trim()) throw new BadRequestError('Add a headline before generating an image');
  return {
    prompt: buildTemplateImagePrompt(template.headline, result),
    sessionName: `Template image for /${listing.name}`,
  };
}

/** Use the first image of one of the author's own finished image generations. */
export async function setOwnTemplateImageFromGeneration(
  user: MarketActor,
  listingId: string,
  questId: string,
  deps: TemplateImageDeps = templateImageDeps()
): Promise<ISkillListingTemplate> {
  const { listing, template } = await requireDraftTemplate(user, listingId, { live: true });
  const quest = await questRepository.findById(questId);
  const session = quest ? await sessionRepository.findById(quest.sessionId) : null;
  if (!quest || !session || session.userId !== user.id) throw new NotFoundError('Image generation not found');
  if (quest.promptMeta?.model?.type !== 'image') throw new BadRequestError('That is not an image generation');
  const name = quest.images?.find(image => GENERATED_IMAGE_EXTENSION_RE.test(image));
  if (!name) {
    throw new ConflictError(quest.type === 'error' ? 'The image generation failed' : 'The image is not ready yet');
  }
  const bytes = await deps.readGeneratedImage(name);
  return attachImage(String(listing.id), user.id, template.slug, bytes, 'generated', deps);
}

export async function approveOwnTemplateImage(user: MarketActor, listingId: string): Promise<ISkillListingTemplate> {
  const { listing, template } = await requireDraftTemplate(user, listingId, { live: false });
  const image = template.previewImage;
  if (!image) throw new ConflictError('Add a preview image first');
  const status = imageStatus(await ownedFile(image.fabFileId, user.id));
  if (status === 'missing') throw new ConflictError('The image file was deleted. Add a new image.');
  if (status === 'blocked') throw new BadRequestError('This image cannot be used. Choose another one.');
  if (status === 'pending') throw new ConflictError('The image is still being checked. Try again in a moment.');
  const updated = await SkillListingTemplate.findOneAndUpdate(
    { listingId: String(listing.id), status: 'draft', 'previewImage.fabFileId': image.fabFileId },
    { $set: { 'previewImage.approved': true } },
    { new: true, runValidators: true }
  );
  if (!updated) throw new ConflictError('The template changed while saving. Reload and try again.');
  return plainTemplate(updated);
}

/** Remove the preview image. The stored file stays in the author's files. */
export async function removeOwnTemplateImage(user: MarketActor, listingId: string): Promise<ISkillListingTemplate> {
  const { listing } = await requireDraftTemplate(user, listingId, { live: false });
  const updated = await SkillListingTemplate.findOneAndUpdate(
    { listingId: String(listing.id), status: 'draft' },
    { $unset: { previewImage: 1 } },
    { new: true, runValidators: true }
  );
  if (!updated) throw new ConflictError('The template changed while saving. Reload and try again.');
  return plainTemplate(updated);
}

/** GET /api/skills/market/[id]/template: the template and what the editor shows around it. */
export async function getOwnTemplateView(
  user: MarketActor,
  listingId: string,
  deps: TemplateImageDeps = templateImageDeps()
): Promise<SkillTemplateEditorView> {
  const listing = await requireOwnListing(user, listingId);
  const id = String(listing.id);
  const live = isLive(listing);
  const [doc, approved, exampleRunsLeft] = await Promise.all([
    SkillListingTemplate.findOne({ listingId: id }),
    live ? approvedSnapshotOf(listing).catch(() => null) : null,
    exampleRunsLeftToday(user.id),
  ]);
  const template = doc ? plainTemplate(doc) : null;

  let previewImageUrl: string | null = null;
  let previewImageStatus: SkillTemplatePreviewImageStatus | null = null;
  if (template?.previewImage) {
    const file = await ownedFile(template.previewImage.fabFileId, listing.authorUserId);
    previewImageStatus = imageStatus(file);
    if (file && previewImageStatus === 'ready') previewImageUrl = await deps.signFileUrl(file.filePath, file.mimeType);
  }

  return {
    template,
    listing: { id, name: listing.name, visibility: listing.visibility, live },
    currentApprovedVersionId: approved?.versionId ?? null,
    eligibility: approved ? skillTemplateFreeRunEligibility(approved.snapshot) : null,
    suggestedSlug: template ? null : await suggestTemplateSlug(listing.name),
    previewImageUrl,
    previewImageStatus,
    exampleRunsLeftToday: exampleRunsLeft,
  };
}

/**
 * The stored preview image of a published template, for the public image route. Null unless the
 * author approved it, the listing is live with a page anyone may open, and the file passed moderation.
 */
export async function findPublicTemplateImage(slug: string): Promise<ImageFile | null> {
  const template = await SkillListingTemplate.findOne({ slug, status: 'published' }).lean();
  if (!template?.previewImage?.approved) return null;
  const listing = await findListing(template.listingId);
  if (!listing || !isLive(listing) || !isPublicTemplatePage(listing)) return null;
  return templatePageImageFile(template, listing);
}

/** True when anyone with the link may open the listing's template page, logged out included. */
export const isPublicTemplatePage = (listing: Pick<ISkillListing, 'visibility'>): boolean =>
  PUBLIC_PAGE_VISIBILITY.has(listing.visibility);

/** The approved, moderation-cleared image file a template page may show, whatever the listing's visibility. */
export async function templatePageImageFile(
  template: Pick<ISkillListingTemplate, 'previewImage'>,
  listing: Pick<ISkillListing, 'authorUserId'>
): Promise<ImageFile | null> {
  const image = template.previewImage;
  if (!image?.approved) return null;
  const file = await ownedFile(image.fabFileId, listing.authorUserId);
  return file && imageStatus(file) === 'ready' ? file : null;
}
