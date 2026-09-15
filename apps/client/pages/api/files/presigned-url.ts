import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { z } from 'zod';
import { Request } from 'express';
import { Resource } from 'sst';
import { FabFile, fabFileRepository } from '@bike4mind/database';
import { isImageServeable } from '@bike4mind/common';
import { isFileInAccessibleLake, resolveAccessibleLakes } from '@server/dataLakes';

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
  tags?: { name: string }[] | null;
  deletedAt?: Date | null;
} | null;

/**
 * S3 key prefixes served WITHOUT an owner/ACL check - the one object class this route legitimately
 * signs for a caller who neither owns the file nor reaches it through a lake: admin "What's New" /
 * banner modal images (uploaded under `modals/`, then shown to every non-admin end user). The
 * allowlist gates by KEY PREFIX independent of whether a FabFile row exists, because a modal image
 * IS usually tracked - an ownership check would (and did) 404 it for every non-admin. Everything not
 * matched here must clear the per-file ACL or the lake gate below.
 */
const OWNERLESS_SERVEABLE_KEY_PREFIXES = ['modals/'];

const isOwnerlessServeableKey = (filePath: string): boolean =>
  OWNERLESS_SERVEABLE_KEY_PREFIXES.some(prefix => filePath.startsWith(prefix));

/**
 * This route maps arbitrary S3 `filePaths[]` to signed URLs, so it must gate each key before
 * signing on two axes: it must not hand out a URL for a held (pending scan) or blocked uploaded
 * image, and it must not sign a file the caller may not read (IDOR). Positional - returns one entry
 * per input `filePath` (`null` where the URL is withheld) so the caller can zip the result back
 * against `filePaths` by index; the client already tolerates a missing URL at a given index.
 *
 * Deny-by-default. A key signs only if it clears moderation AND is either an allowlisted
 * ownerless-serveable prefix (see `OWNERLESS_SERVEABLE_KEY_PREFIXES`) or a tracked file the caller
 * may read (`isAccessible`). An untracked, non-allowlisted key (`lookup` -> `null`) is DENIED: this
 * route shares a bucket with export/archive objects that carry no FabFile row, and signing those
 * for any authenticated caller was an IDOR. The allowlist does NOT bypass moderation - a held modal
 * image is still withheld.
 */
export async function filterServeableFilePaths(
  filePaths: string[],
  lookup: (filePath: string) => Promise<FabFileLookupResult>,
  isAccessible: (fabFile: NonNullable<FabFileLookupResult>) => Promise<boolean>,
  isAllowlisted: (filePath: string) => boolean = isOwnerlessServeableKey
): Promise<(string | null)[]> {
  return Promise.all(
    filePaths.map(async filePath => {
      const fabFile = await lookup(filePath);
      if (fabFile && !isImageServeable(fabFile)) return null; // held/blocked by moderation
      if (isAllowlisted(filePath)) return filePath; // ownerless-serveable prefix (e.g. modal images)
      if (!fabFile) return null; // untracked, non-allowlisted key - no owner to authorize (IDOR guard)
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
      // Resolved at most once, and only when a file fails the per-file ACL below - a bulk sign of
      // owned files must not pay for a lake-resolution DB read it never needs. Mirrors the
      // resolve-once, reuse-everywhere shape of files/byIds.ts and files/[id]'s lake fallback.
      let lakesPromise: ReturnType<typeof resolveAccessibleLakes> | undefined;
      const accessibleLakes = () => (lakesPromise ??= resolveAccessibleLakes(req));

      const serveableFileKeys = await filterServeableFilePaths(
        decodedFileKeys,
        filePath => FabFile.findOne({ filePath }).lean(),
        async fabFile => {
          const id = String(fabFile._id);
          if (await fabFileRepository.shareable.findAccessibleById(req.user, id)) return true;
          if (fabFile.deletedAt) return false; // soft-deleted lake article must not sign (mirrors files/[id])
          const lakes = await accessibleLakes();
          return isFileInAccessibleLake(lakes, fabFile);
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
