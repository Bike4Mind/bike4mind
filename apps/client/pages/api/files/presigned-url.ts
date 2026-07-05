import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { z } from 'zod';
import { NextApiRequest, NextApiResponse } from 'next';
import { Resource } from 'sst';
import { FabFile } from '@bike4mind/database';
import { isImageServeable } from '@bike4mind/common';

const s3Client = new S3Client();

const GetPresignedUrlRequestInput = z.object({
  filePaths: z.array(z.string()),
  expiresIn: z.number().optional().prefault(3600), // Default to 1 hour
});

/** Minimal shape a FabFile lookup needs to expose for the moderation gate below. */
type FabFileModerationLookupResult = { mimeType?: string | null; moderationStatus?: string | null } | null;

/**
 * This route maps arbitrary S3 `filePaths[]` to signed URLs with no built-in
 * ownership check, so it must not hand out a URL for a held (pending scan) or
 * blocked uploaded image. Positional - returns one entry per input `filePath`
 * (`null` where the URL is withheld) so the caller can zip the result back against
 * `filePaths` by index; the client already tolerates a missing URL at a given index.
 *
 * A `filePath` with no FabFile record (`lookup` returns `null`) is passed through
 * unchanged: this route also serves S3 keys that aren't tracked as a FabFile (e.g. admin
 * "What's New" modal images), and those can't be moderation-gated because there's nothing
 * to check. Only a known image FabFile that isn't `isImageServeable` gets dropped.
 */
export async function filterServeableFilePaths(
  filePaths: string[],
  lookup: (filePath: string) => Promise<FabFileModerationLookupResult>
): Promise<(string | null)[]> {
  return Promise.all(
    filePaths.map(async filePath => {
      const fabFile = await lookup(filePath);
      if (fabFile && !isImageServeable(fabFile)) return null;
      return filePath;
    })
  );
}

const handler = baseApi().get(async (req: NextApiRequest, res: NextApiResponse) => {
  let filePathsQuery = req.query['filePaths[]'];

  if (typeof filePathsQuery === 'string') {
    filePathsQuery = [filePathsQuery];
  }

  const { filePaths: validatedFilePaths, expiresIn } = GetPresignedUrlRequestInput.parse({
    filePaths: filePathsQuery,
    expiresIn: req.query.expiresIn ? parseInt(req.query.expiresIn as string, 10) : undefined,
  });

  try {
    // Parse the URL to get the file key
    const decodedFileKeys = validatedFilePaths.map(filePath => decodeURIComponent(filePath));

    // Withhold URLs for held/blocked uploaded images before signing anything.
    const serveableFileKeys = await filterServeableFilePaths(decodedFileKeys, filePath =>
      FabFile.findOne({ filePath }).lean()
    );

    const presignedUrls = await Promise.all(
      serveableFileKeys.map(decodedFilePath => {
        if (!decodedFilePath) return null;
        const command = new GetObjectCommand({
          Bucket: Resource.fabFileBucket.name,
          Key: decodedFilePath,
        });
        return getSignedUrl(s3Client, command, { expiresIn });
      })
    );

    return res.json({ urls: presignedUrls });
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    throw new BadRequestError('Failed to generate presigned URL');
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
