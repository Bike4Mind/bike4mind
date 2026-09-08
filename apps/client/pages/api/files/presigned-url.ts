import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { z } from 'zod';
import { Request } from 'express';
import { Resource } from 'sst';
import { FabFile, fabFileRepository } from '@bike4mind/database';
import { isImageServeable } from '@bike4mind/common';
import { findLakeAccessibleFabFile } from '@server/dataLakes';

const s3Client = new S3Client();

const GetPresignedUrlRequestInput = z.object({
  filePaths: z.array(z.string()),
  expiresIn: z.number().optional().prefault(3600), // Default to 1 hour
});

/** Minimal shape a FabFile lookup needs to expose for the moderation + ownership gates below. */
type FabFileLookupResult = {
  _id: unknown;
  mimeType?: string | null;
  moderationStatus?: string | null;
} | null;

/**
 * This route maps arbitrary S3 `filePaths[]` to signed URLs, so it must gate each key before
 * signing on two axes: it must not hand out a URL for a held (pending scan) or blocked uploaded
 * image, and it must not sign another user's file (IDOR). Positional - returns one entry per input
 * `filePath` (`null` where the URL is withheld) so the caller can zip the result back against
 * `filePaths` by index; the client already tolerates a missing URL at a given index.
 *
 * A `filePath` with no FabFile record (`lookup` returns `null`) is passed through unchanged: this
 * route also serves S3 keys that aren't tracked as a FabFile (e.g. admin "What's New" modal
 * images), which have no owner to check and can't be moderation-gated. A tracked file is dropped
 * if it isn't `isImageServeable`, or if `isAccessible` says the caller may not read it.
 */
export async function filterServeableFilePaths(
  filePaths: string[],
  lookup: (filePath: string) => Promise<FabFileLookupResult>,
  isAccessible: (fabFile: NonNullable<FabFileLookupResult>) => Promise<boolean>
): Promise<(string | null)[]> {
  return Promise.all(
    filePaths.map(async filePath => {
      const fabFile = await lookup(filePath);
      if (!fabFile) return filePath; // untracked S3 key - no owner/moderation record to check
      if (!isImageServeable(fabFile)) return null; // held/blocked by moderation
      if (!(await isAccessible(fabFile))) return null; // not the caller's to read
      return filePath;
    })
  );
}

const handler = baseApi().get(
  async (req: Request<unknown, unknown, unknown, { 'filePaths[]'?: string | string[]; expiresIn?: string }>, res) => {
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

      // Withhold URLs for held/blocked images and for files the caller may not read, before signing.
      // Access mirrors GET /api/files/:id: per-file ACL (owner/share) OR the lake gate that
      // authorizes curated/shared lake articles by tag/prefix - so opening a shared lake article
      // still works. The lake fallback only runs for tracked files the ACL didn't already allow.
      const serveableFileKeys = await filterServeableFilePaths(
        decodedFileKeys,
        filePath => FabFile.findOne({ filePath }).lean(),
        async fabFile => {
          const id = String(fabFile._id);
          if (await fabFileRepository.shareable.findAccessibleById(req.user, id)) return true;
          return !!(await findLakeAccessibleFabFile(req, id));
        }
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
  }
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
