import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { getGeneratedImageStorage } from '@server/utils/storage';
import { z } from 'zod';

const refSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z]+$/i,
    'Invalid ref format. Expected UUID with extension (e.g. 9db8f846-08d5-47d7-9166-a039d3c3d4d7.png)'
  );

const PRESIGNED_URL_EXPIRY_SECONDS = 3600;

const handler = baseApi().get(
  asyncHandler<unknown, unknown, unknown, { ref?: string; format?: string }>(async (req, res) => {
    // Validate ref format - catch ZodError so we return 400 (not 422)
    let ref: string;
    try {
      ref = refSchema.parse(req.query.ref);
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestError(err.issues[0]?.message ?? 'Invalid ref parameter');
      }
      throw err;
    }

    // Verify the object exists and get metadata
    let metadata: { size: number | undefined; contentType: string | undefined };
    try {
      metadata = await getGeneratedImageStorage().getMetadata(ref);
    } catch (err: unknown) {
      const error = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
      if (
        error.name === 'NotFound' ||
        error.name === 'NoSuchKey' ||
        error.code === 'NoSuchKey' ||
        error.$metadata?.httpStatusCode === 404
      ) {
        throw new NotFoundError(`Content not found: ${ref}`);
      }
      throw err;
    }

    // Generate presigned URL with content-disposition for browser download
    const presignedUrl = await getGeneratedImageStorage().getSignedUrl(ref, 'get', {
      expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
      ResponseContentDisposition: `attachment; filename="${ref}"`,
    });

    // JSON format requested - return metadata + URL
    if (req.query.format === 'json') {
      return res.json({
        url: presignedUrl,
        contentType: metadata.contentType,
        size: metadata.size,
        expiresAt: new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000).toISOString(),
      });
    }

    // Default: redirect to presigned URL
    return res.redirect(302, presignedUrl);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
