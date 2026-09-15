import { Permission } from '@bike4mind/common';
import { Session } from '@bike4mind/database/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { UploadTooLargeError, spoolRequestToFile } from '@server/utils/spoolRequestToFile';
import { Resource } from 'sst';
import type { Request, Response } from 'express';

/**
 * Ceiling for a proxied notebook import upload. A notebook export is JSON (sessions, artifacts,
 * tools), not the archive a ChatGPT/Claude history export is, so it does not need the
 * history-import proxy's 1 GB allowance - 100 MB comfortably covers even a large workspace
 * exported as JSON.
 */
export const MAX_NOTEBOOK_IMPORT_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * importId is the only client-supplied part of the key: pages/api/notebooks/import.ts already
 * wrote the sibling `<importId>.options.json` using this same timestamp, so it must round-trip
 * unchanged. It is validated as digits-only so it can never carry a path segment out of the
 * caller's own prefix.
 */
const isValidImportId = (importId: string): boolean => /^\d+$/.test(importId);

const notebookImportKey = (userId: string, importId: string): string => `notebooks/${userId}/${importId}.json`;

const handler = baseApi({ maxBodySize: MAX_NOTEBOOK_IMPORT_UPLOAD_BYTES })
  /**
   * Self-host upload proxy (PUT). MinIO is not browser-reachable and its presign is blocked by
   * the CSP connect-src allow-list, so the browser PUTs here instead and the bytes are written
   * to storage server-side under the same key shape import.ts already computed.
   *
   * Self-host only (404 otherwise).
   */
  .put(
    asyncHandler(async (req: Request, res: Response) => {
      if (process.env.B4M_SELF_HOST !== 'true') {
        return res.status(404).json({ error: 'Not found' });
      }

      const importId = String((req.query as { importId?: string }).importId ?? '');
      if (!isValidImportId(importId)) {
        return res.status(400).json({ error: 'Invalid importId' });
      }
      // Same gate the POST applies, re-checked here: this route accepts bytes on its own, so it
      // cannot rely on the presign step having happened.
      if (!req.ability?.can(Permission.create, Session)) {
        return res.status(403).json({ error: 'Cannot create session' });
      }

      let spooled;
      try {
        spooled = await spoolRequestToFile(req, MAX_NOTEBOOK_IMPORT_UPLOAD_BYTES, { filename: 'notebook-import.json' });
      } catch (err) {
        if (err instanceof UploadTooLargeError) {
          // Same teardown as import-history/upload.ts: FIN after the body flushes, never an RST.
          res.on('finish', () => req.socket?.end());
          return res
            .status(413)
            .json({ error: 'Notebook import exceeds the maximum upload size', maxBytes: err.maxBytes });
        }
        throw err;
      }

      try {
        const key = notebookImportKey(String(req.user.id), importId);
        await new S3Storage(Resource.historyImportBucket.name).upload(spooled.path, key);
        req.logger?.info(
          `[notebooks/import] proxied upload user=${req.user.id} importId=${importId} bytes=${spooled.bytes}`
        );
        return res.status(200).json({ success: true });
      } finally {
        await spooled.cleanup();
      }
    })
  );

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default handler;
