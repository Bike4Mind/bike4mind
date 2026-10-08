import { isImageServeable, type DecisionInput, type DecisionModelCapabilities } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { NotFoundError } from '@bike4mind/utils';
import type { ResolvedDecisionInput, ResolvedDecisionInputPart } from '@bike4mind/utils/decisionProviders';
import { ensureImageWithinDimensionLimit } from '@bike4mind/utils/imageResize';
import { assertFilesReadScope } from '@server/files/fileScopes';
import { loadAccessibleFabFile } from '@server/files/loadAccessibleFabFile';
import { getFilesStorage } from '@server/utils/storage';
import type { Request } from 'express';
import { isValidObjectId } from 'mongoose';

const DECISION_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** Ceiling on a `file_id` image before download; anything larger is not a photo a decision needs. */
const MAX_DECISION_IMAGE_FILE_BYTES = 20 * 1024 * 1024;

/** A caller-fixable image problem, mapped by the route to its status and error code. */
export class DecisionImageError extends Error {
  constructor(
    readonly status: 404 | 422,
    readonly errorCode: 'input_image_not_found' | 'unsupported_input' | 'limit_exceeded',
    readonly param: string,
    message: string
  ) {
    super(message);
    this.name = 'DecisionImageError';
  }
}

type ImageBytes = { bytes: Buffer; mimeType: string };

const loadFileImage = async (req: Request, fileId: string, param: string): Promise<ImageBytes> => {
  const notFound = new DecisionImageError(404, 'input_image_not_found', param, `No readable file ${fileId}`);
  if (!isValidObjectId(fileId)) throw notFound;
  // The same scope and ACL gates as GET /api/v1/files/{id}, so this door cannot authorize differently: an
  // `ai:decide` key minted without `files:read` must not be able to ask questions about the owner's files.
  assertFilesReadScope(req);
  const fabFile = await loadAccessibleFabFile(req, fileId).catch((error: unknown) => {
    throw error instanceof NotFoundError ? notFound : error;
  });
  // A record whose upload never landed has nothing to read.
  if (!fabFile.filePath) throw notFound;
  if (!DECISION_IMAGE_MIME_TYPES.has(fabFile.mimeType)) {
    throw new DecisionImageError(
      422,
      'unsupported_input',
      param,
      `File ${fileId} is ${fabFile.mimeType}, not an image`
    );
  }
  if (!isImageServeable(fabFile)) {
    const reason =
      fabFile.moderationStatus === 'blocked' ? 'is blocked by moderation' : 'is still being scanned; retry shortly';
    throw new DecisionImageError(422, 'unsupported_input', param, `File ${fileId} ${reason}`);
  }
  if (fabFile.fileSize > MAX_DECISION_IMAGE_FILE_BYTES) {
    throw new DecisionImageError(
      422,
      'limit_exceeded',
      param,
      `Images are limited to ${MAX_DECISION_IMAGE_FILE_BYTES} bytes`
    );
  }
  return { bytes: await getFilesStorage().download(fabFile.filePath), mimeType: fabFile.mimeType };
};

// The schema has already pinned the shape to `data:image/<type>;base64,<payload>`.
const decodeDataUrl = (dataUrl: string): ImageBytes => {
  const comma = dataUrl.indexOf(',');
  return {
    mimeType: dataUrl.slice('data:'.length, dataUrl.indexOf(';')),
    bytes: Buffer.from(dataUrl.slice(comma + 1), 'base64'),
  };
};

const toDownscaledDataUrl = async (
  image: ImageBytes,
  caps: DecisionModelCapabilities,
  param: string,
  logger: Logger
): Promise<string> => {
  const bytes = await ensureImageWithinDimensionLimit(image.bytes, caps.limits.maxImageDimension, logger);
  if (!bytes) throw new DecisionImageError(422, 'limit_exceeded', param, 'Image declares too many pixels to decode');
  // Labelled with the declared type: the bytes are only re-encoded when a resize happens, and then in the format jimp
  // decoded. Formats jimp cannot decode (webp) pass through unresized, and the vendor enforces its own size cap.
  return `data:${image.mimeType};base64,${bytes.toString('base64')}`;
};

/** Resolves every image to a data URL, downscaled where the format allows. Run after `validateDecisionRequest`, which fixes the part shapes. */
export const resolveDecisionInput = async (
  req: Request,
  input: DecisionInput,
  caps: DecisionModelCapabilities
): Promise<ResolvedDecisionInput> => {
  if (typeof input === 'string') return input;
  return Promise.all(
    input.map(async (part, index): Promise<ResolvedDecisionInputPart> => {
      if (part.type !== 'image') return part;
      const param = `input[${index}]`;
      const image = part.file_id
        ? await loadFileImage(req, part.file_id, `${param}.file_id`)
        : decodeDataUrl(part.image_url ?? '');
      return { type: 'image', dataUrl: await toDownscaledDataUrl(image, caps, param, req.logger) };
    })
  );
};
