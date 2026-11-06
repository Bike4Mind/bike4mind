import {
  FabFileSourceType,
  FileEvents,
  GeneratedAssetLineageEntrySchema,
  GeneratedAssetMetadataSchema,
  Permission,
  SupportedFabFileMimeTypes,
  extensionFromMimeType,
  isImageServeable,
  fabFileResponseSchema,
  type GeneratedAssetLineageEntry,
  type GeneratedAssetMetadata,
  type IFabFileDocument,
} from '@bike4mind/common';
import {
  FabFile,
  User,
  fabFileRepository,
  organizationRepository,
  questRepository,
  withTransaction,
  adminSettingsRepository,
  dataLakeRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import { saveGeneratedAsset } from '@bike4mind/services';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { respond } from '@server/utils/respond';
import { BadRequestError, ForbiddenError, InternalServerError } from '@bike4mind/server-utils/utils/errors';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { userCanAccessGeneratedImage } from '@bike4mind/server-utils/utils/generatedImageAccess';
import { FILES_WRITE_SCOPES } from '@server/files/fileScopes';
import { consumeFileUploadBudget } from '@server/files/fileUploadBudget';
import { z } from 'zod';
import { requesterScopedUsers } from '@bike4mind/server-utils/auth/apiKeyAdminScope';

const copyGeneratedImageSchema = z.object({
  imageS3Key: z.string().describe('The S3 key of the image in the generatedImagesBucket'),
  fileName: z.string().optional().describe('Optional custom filename for the saved image'),
});

type CopyGeneratedImageInput = z.infer<typeof copyGeneratedImageSchema>;

const handler = baseApi({ requiredScopes: FILES_WRITE_SCOPES })
  .use((req, res, next) => {
    if (!req.ability?.can(Permission.create, FabFile)) {
      throw new BadRequestError('Unauthorized');
    }
    next();
  })
  .post(
    asyncHandler<unknown, unknown, CopyGeneratedImageInput>(async (req, res) => {
      const { user, logger } = req;
      const { imageS3Key, fileName } = copyGeneratedImageSchema.parse(req.body);

      // Object-level authz: generated-image keys are owner-less, so a caller could otherwise copy
      // any user's image into their own files by supplying its key. Only copy an image the caller
      // created (or one shared with them via the source chat).
      if (!(await userCanAccessGeneratedImage(imageS3Key, user))) {
        throw new ForbiddenError('You do not have access to this image');
      }

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

      // Provenance is secondary to keeping the image: a failed lookup saves it unrecorded rather than failing.
      const original = await findOriginalGeneration(imageS3Key, user.id).catch((error: unknown) => {
        logger.warn('[copy-generated-image] original generation lookup failed', { error });
        return undefined;
      });
      const fileId = await withTransaction(async () => {
        const saved = await saveGeneratedAsset(
          {
            userId: user.id,
            bytes: imageBuffer,
            // Off the stored S3 object, never the request body, so it outranks a caller-supplied fileName.
            contentType,
            generation: original?.generation ?? UNRECORDED_IMAGE_GENERATION,
            ...(original?.derivedFrom && { derivedFrom: original.derivedFrom }),
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
              generateSignedUrl: (filepath: string, expireInSeconds: number, mode?: 'get' | 'put') =>
                getFilesStorage().getSignedUrl(filepath, mode ?? 'get', {
                  expiresIn: expireInSeconds,
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
      const result = await fabFileRepository.findById(fileId);
      if (!result) throw new InternalServerError('Failed to save the image to your files');

      await logEvent(
        { userId: user.id, type: FileEvents.CREATE_FILE, metadata: { fileId: result.id } },
        { ability: req.ability }
      );

      // The generated image is already moderated, but the new FabFile row starts 'pending' until
      // the async objectCreated scan clears it - only return a working URL once serveable;
      // otherwise return the record with no fileUrl so the client can show a placeholder.
      const responseFile =
        typeof (result as { toJSON?: unknown }).toJSON === 'function'
          ? (result as unknown as { toJSON: () => IFabFileDocument }).toJSON()
          : result;
      if (responseFile.filePath && isImageServeable(responseFile)) {
        const presignedUrl = await getFilesStorage().getSignedUrl(responseFile.filePath, 'get', {
          expiresIn: 3600,
          audience: 'browser',
        });

        return respond(res, fabFileResponseSchema, {
          ...responseFile,
          fileUrl: presignedUrl,
          fileUrlExpireAt: new Date(Date.now() + 3600 * 1000),
        });
      }

      return respond(res, fabFileResponseSchema, responseFile);
    })
  );

// A chat image from before generations were recorded: kept as a generated image with no request or lineage.
const UNRECORDED_IMAGE_GENERATION: GeneratedAssetMetadata = { generator: 'image', provider: 'unknown', prompt: '' };

/**
 * The generation record of the file the image producers saved alongside this chat image (ImageGeneration /
 * ImageEdit stamp `sourceMetadata.generatedOutputKey`), so the copy carries the same request. Searched within the
 * chats whose turns reference the key, which the partial sessionId index serves. Lineage is reused only for the
 * original's owner: a share recipient's copy must not point at files they cannot open.
 */
async function findOriginalGeneration(
  imageKey: string,
  userId: string
): Promise<{ generation: GeneratedAssetMetadata; derivedFrom?: GeneratedAssetLineageEntry[] } | undefined> {
  const sessionIds = await questRepository.findSessionIdsByImage(imageKey);
  if (sessionIds.length === 0) return undefined;
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
  const derivedFrom = GeneratedAssetLineageEntrySchema.array().safeParse(file.derivedFrom);
  return {
    generation: rest,
    ...(file.userId === userId && derivedFrom.success && { derivedFrom: derivedFrom.data }),
  };
}

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
