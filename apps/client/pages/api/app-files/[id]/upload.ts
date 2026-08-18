import { adminSettingsRepository } from '@bike4mind/database';
import { AppFile } from '@bike4mind/database/content';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { getAppFilesStorage } from '@server/utils/storage';
import type { Request, Response } from 'express';

/**
 * Self-host app-file upload proxy (PUT).
 *
 * The AppFile twin of pages/api/files/[id]/upload.ts, for the app-files bucket: generic app files,
 * organization logos and profile photos. In AWS the browser PUTs straight to S3 with the presign
 * those endpoints return; self-host has no browser-reachable S3 (the presign targets the internal
 * MinIO host, unreachable and blocked by CSP), so resolveBrowserAppFileUploadUrl hands the browser
 * this same-origin route instead and it writes the bytes to storage server-side.
 *
 * Auth is normal baseApi (the logged-in user / API key), but the target AppFile must exist, have
 * been created by the caller, and still be awaiting upload - so the presign-issuing endpoint's own
 * authorization (org membership, self-or-admin for photos) is what gates the write. Marking the
 * AppFile complete here mirrors server/s3/appFileUploadComplete.ts, whose ObjectCreated webhook
 * still fires and whose status write is then an idempotent no-op.
 *
 * Self-host only (404 otherwise).
 */

const DEFAULT_MAX_FILE_SIZE_MB = 20; // mirror pages/api/files/[id]/upload.ts
/** Coarse Content-Length pre-check ceiling; the exact MaxFileSize cap is enforced mid-stream. */
const BODY_CEILING_BYTES = 512 * 1024 * 1024;

const handler = baseApi({ maxBodySize: BODY_CEILING_BYTES }).put(
  asyncHandler(async (req: Request, res: Response) => {
    if (process.env.B4M_SELF_HOST !== 'true') {
      return res.status(404).json({ error: 'Not found' });
    }

    const appFileId = String((req.query as { id?: string }).id ?? '');
    const appFile = await AppFile.findById(appFileId);
    // Same 404 for missing and not-owned so the route doesn't leak which files exist.
    if (!appFile || appFile.userId !== req.user.id) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (appFile.status !== 'pending') {
      return res.status(400).json({ error: 'File is not awaiting upload' });
    }
    if (!appFile.path) {
      return res.status(400).json({ error: 'File has no storage path' });
    }
    const filePath = appFile.path;

    const maxBytes =
      getSettingsValue(
        'MaxFileSize',
        await getSettingsMap({ adminSettings: adminSettingsRepository }),
        DEFAULT_MAX_FILE_SIZE_MB
      ) *
      1024 *
      1024;

    // Stream with a hard mid-stream cap so a client that lies about (or omits) Content-Length
    // can't exhaust memory: stop and 413 the moment the cap is exceeded.
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      received += buf.length;
      if (received > maxBytes) {
        req.destroy();
        return res.status(413).json({ error: 'File size exceeds maximum file size', maxBytes });
      }
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks);

    // Write to the AppFile's own storage key (from the DB, never client-supplied) so the caller
    // can't target an arbitrary key and the webhook fires on the expected object.
    await getAppFilesStorage().upload(body, filePath, {
      ContentType: appFile.mimeType || (req.headers['content-type'] as string) || 'application/octet-stream',
      ContentLength: body.length,
    });

    // A successful write proves the object landed, so mark complete here rather than depending on
    // the webhook; the webhook's own status write (when it arrives) is an idempotent no-op.
    appFile.status = 'complete';
    await appFile.save();

    return res.status(200).json({ ok: true, appFileId: appFile.id });
  })
);

// Raw stream: disable Next's body parser so we can size-cap and forward the bytes ourselves.
export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default handler;
