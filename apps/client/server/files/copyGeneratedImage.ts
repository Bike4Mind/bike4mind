import {
  FabFileSourceType,
  FileEvents,
  GeneratedAssetMetadataSchema,
  SupportedFabFileMimeTypes,
  extensionFromMimeType,
  type GeneratedAssetMetadata,
} from '@bike4mind/common';
import {
  User,
  adminSettingsRepository,
  dataLakeRepository,
  fabFileRepository,
  organizationRepository,
  questRepository,
  scopedSettingsRepository,
  withTransaction,
} from '@bike4mind/database';
import { saveGeneratedAsset } from '@bike4mind/services';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { ForbiddenError, InternalServerError } from '@bike4mind/server-utils/utils/errors';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { userCanAccessGeneratedImage } from '@bike4mind/server-utils/utils/generatedImageAccess';
import { requesterScopedUsers } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { consumeFileUploadBudget } from '@server/files/fileUploadBudget';
import type { Request } from 'express';

export type CopiedGeneratedImage = {
  fileId: string;
  /** False when the caller's own file for this image already existed and is returned as-is. */
  created: boolean;
};

// A chat image from before generations were recorded: kept as a generated image with no request or lineage.
// GenerationDetails hides this exact record; keep the two in sync.
const UNRECORDED_IMAGE_GENERATION: GeneratedAssetMetadata = { generator: 'image', provider: 'unknown', prompt: '' };

/**
 * Saves a generated-bucket image (a legacy chat image, `quest.images`) to the caller's files, for
 * POST /api/files/copy-generated-image and the chat image job carry-forward (server/generations/chatImageJobRequest.ts).
 * Throws ForbiddenError when the caller may not read the image, and the upload budget's 429 when it is spent. A new
 * file starts 'pending' moderation like any upload; the caller decides whether to wait for its scan.
 */
export async function copyGeneratedImageToFiles(
  req: Request<unknown, unknown, unknown, unknown>,
  params: { imageS3Key: string; fileName?: string }
): Promise<CopiedGeneratedImage> {
  const { user, logger } = req;
  const { imageS3Key, fileName } = params;

  // Object-level authz: generated-image keys are owner-less, so a caller could otherwise copy
  // any user's image into their own files by supplying its key. Only copy an image the caller
  // created (or one shared with them via the source chat).
  if (!(await userCanAccessGeneratedImage(imageS3Key, user))) {
    throw new ForbiddenError('You do not have access to this image');
  }

  // Provenance is secondary to keeping the image: a failed lookup saves it unrecorded rather than failing.
  const original = await findOriginalGeneration(imageS3Key, user.id).catch((error: unknown) => {
    logger.warn('[copy-generated-image] original generation lookup failed', { error });
    return undefined;
  });

  // The caller's own generated file is the saved image: return it rather than a duplicate copy.
  if (original?.ownFileId) return { fileId: original.ownFileId, created: false };

  const imageBuffer = await getGeneratedImageStorage().download(imageS3Key);

  const metadata = await getGeneratedImageStorage().getMetadata(imageS3Key);
  const storedType = metadata.contentType;
  // An octet-stream (what S3 reports for objects written without an explicit ContentType)
  // carries no type at all, and claim-first would then fall through to the caller-supplied
  // fileName - storing PNG bytes as whatever "notes.txt" claims. Treat it as absent. This
  // single substring match is deliberately broader than the two-spelling check in
  // b4m-core/fab-pipeline/src/ingest.ts, so it also catches cased and parameterised variants
  // (e.g. "; charset=binary").
  // A type with no known extension (e.g. image/avif) is likewise stored as PNG: the generated-asset seam
  // refuses a type it cannot name a file for.
  const contentType =
    !storedType || storedType.trim().toLowerCase().includes('octet-stream') || !extensionFromMimeType(storedType)
      ? SupportedFabFileMimeTypes.PNG
      : storedType;

  await consumeFileUploadBudget(req, 1);

  const fileId = await withTransaction(async () => {
    const saved = await saveGeneratedAsset(
      {
        userId: user.id,
        bytes: imageBuffer,
        // Off the stored S3 object, never the request body, so it outranks a caller-supplied fileName.
        contentType,
        generation: original?.generation ?? UNRECORDED_IMAGE_GENERATION,
        generatedOutputKey: imageS3Key,
        ...(fileName && { fileName }),
      },
      {
        db: {
          adminSettings: adminSettingsRepository,
          // Absent, the admission lever (#1680) resolves platform-only here, so a per-org/owner/lake
          // enforcement override would silently not apply on this door.
          scopedSettings: scopedSettingsRepository,
          fabFiles: fabFileRepository,
          users: requesterScopedUsers(req, User),
          organizations: organizationRepository,
          dataLakes: dataLakeRepository,
        },
        storage: {
          upload: (filepath, content, option) =>
            getFilesStorage().upload(content, filepath, { ContentType: option?.ContentType || contentType }),
          generateSignedUrl: (filepath, expireInSeconds, mode, options) =>
            getFilesStorage().getSignedUrl(filepath, mode ?? 'get', {
              expiresIn: expireInSeconds,
              ResponseContentDisposition: options?.ResponseContentDisposition,
              ResponseContentType: options?.ResponseContentType,
            }),
        },
        logger,
      }
    );
    // The caller is waiting on this file, so a refused save fails the request and rolls the transaction
    // back; a storage-limit refusal keeps its 400 and byte counts.
    if (!saved.saved) throw saved.cause ?? new InternalServerError('Failed to save the image to your files');
    return saved.fileId;
  });

  await logEvent({ userId: user.id, type: FileEvents.CREATE_FILE, metadata: { fileId } }, { ability: req.ability });
  return { fileId, created: true };
}

/**
 * Matched within the chats that reference the key, which the partial sessionId index serves, to find the file the
 * image producers saved for it. `ownFileId` is set only when that file is the caller's, to be returned as-is.
 */
async function findOriginalGeneration(
  imageKey: string,
  userId: string
): Promise<{ generation: GeneratedAssetMetadata; ownFileId?: string } | undefined> {
  const sessionIds = await questRepository.findSessionIdsByImage(imageKey);
  if (sessionIds.length === 0) return undefined;
  // Deliberately wide (soft-deleted, other users' sessions, no userId filter): authz already ran and the bytes are the same image.
  const file = await fabFileRepository.findOne({
    sourceType: FabFileSourceType.TOOL_GENERATED,
    'sourceMetadata.sessionId': { $in: sessionIds },
    'sourceMetadata.generatedOutputKey': imageKey,
    deletedAt: null,
  });
  const generation = GeneratedAssetMetadataSchema.safeParse(file?.sourceMetadata?.generation);
  if (!file || !generation.success) return undefined;
  // A fresh save, not the original's job: reusing jobId would dedupe straight back to the original file.
  const { jobId: _jobId, ...rest } = generation.data;
  return { generation: rest, ...(file.userId === userId && { ownFileId: file.id }) };
}
