import { Permission } from '@bike4mind/common';
import { Session } from '@bike4mind/database/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { importHistoryService } from '@bike4mind/services';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { resolveBrowserHistoryImportUploadUrl } from '@server/utils/browserUploadUrl';
import { UploadTooLargeError, spoolRequestToFile } from '@server/utils/spoolRequestToFile';
import { Resource } from 'sst';
import type { Request, Response } from 'express';

interface IParams {
  source: string;
}

/**
 * Ceiling for a proxied history upload. Deliberately NOT the `MaxFileSize` admin setting the
 * fab-file and app-file proxies use: that defaults to 20MB and describes user file uploads,
 * while a real ChatGPT export is routinely far larger, so reusing it would silently break the
 * feature on self-host. The hosted presigned path has no cap at all, so this is a self-host-only
 * limit whose job is bounding disk use, not policing content.
 */
export const MAX_HISTORY_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB

const isKnownSource = (source: string): boolean =>
  source === importHistoryService.ImportSource.OPENAI || source === importHistoryService.ImportSource.CLAUDE;

/**
 * The storage key IS the identity record for this upload: server/s3/historyUploadComplete.ts
 * splits userId and source back out of it to decide whose history is being imported. It is
 * therefore always computed from the authenticated request and never from anything the client
 * sends - there is no owning DB row to check a client-supplied key against.
 */
const historyImportKey = (userId: string, source: string): string => `${userId}/${source}/${Date.now()}.zip`;

const handler = baseApi({ maxBodySize: MAX_HISTORY_UPLOAD_BYTES })
  .get(
    asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
      const { source } = req.query;
      if (!isKnownSource(source)) {
        throw new Error('Invalid source');
      }

      if (!req.ability?.can(Permission.create, Session)) throw new Error('Cannot create session');

      // Self-host gets the same-origin proxy below; hosted keeps the presign untouched. Minting
      // one on self-host would be a wasted MinIO round trip: the resolver discards it, and the
      // key it burns is not the key the PUT handler lands the bytes under.
      let url = '';
      if (process.env.B4M_SELF_HOST !== 'true') {
        const s3 = new S3Storage(Resource.historyImportBucket.name);
        url = await s3.getSignedUrl(historyImportKey(String(req.user?.id), source), 'put', { expiresIn: 600 });
      }

      return res.json({ success: true, url: resolveBrowserHistoryImportUploadUrl(source, url) });
    })
  )
  /**
   * Self-host upload proxy (PUT). MinIO is not browser-reachable and its presign is blocked by
   * the CSP connect-src allow-list, so the browser PUTs here instead and the bytes are written
   * to storage server-side under the same key shape. The MinIO ObjectCreated webhook then fires
   * and historyUploadComplete runs unchanged.
   *
   * Spooled to disk rather than buffered: a history export is large enough that holding it in
   * the app pod would be a real memory problem, and S3Storage.upload takes a path.
   *
   * Self-host only (404 otherwise).
   */
  .put(
    asyncHandler(async (req: Request, res: Response) => {
      if (process.env.B4M_SELF_HOST !== 'true') {
        return res.status(404).json({ error: 'Not found' });
      }

      const source = String((req.query as { source?: string }).source ?? '');
      if (!isKnownSource(source)) {
        return res.status(400).json({ error: 'Invalid source' });
      }
      // Same gate the GET applies, re-checked here: this route accepts bytes on its own, so it
      // cannot rely on the presign step having happened.
      if (!req.ability?.can(Permission.create, Session)) {
        return res.status(403).json({ error: 'Cannot create session' });
      }

      let spooled;
      try {
        spooled = await spoolRequestToFile(req, MAX_HISTORY_UPLOAD_BYTES, { filename: 'history.zip' });
      } catch (err) {
        if (err instanceof UploadTooLargeError) {
          req.destroy();
          return res
            .status(413)
            .json({ error: 'History archive exceeds the maximum upload size', maxBytes: err.maxBytes });
        }
        throw err;
      }

      try {
        const key = historyImportKey(String(req.user.id), source);
        await new S3Storage(Resource.historyImportBucket.name).upload(spooled.path, key);
        req.logger?.info(`[import-history] proxied upload user=${req.user.id} source=${source} bytes=${spooled.bytes}`);
        return res.status(200).json({ success: true });
      } finally {
        await spooled.cleanup();
      }
    })
  );

export const config = {
  api: {
    // The PUT streams its body; the GET has none.
    bodyParser: false,
    externalResolver: true,
  },
};

export default handler;
