import { adminSettingsRepository, FabFile } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { getFilesStorage } from '@server/utils/storage';
import type { Request, Response } from 'express';

/**
 * Self-host file-upload proxy (PUT).
 *
 * In AWS the browser PUTs directly to S3 via a presigned URL. Self-host has no reachable S3:
 * the presign would target the internal MinIO host (unreachable from a browser and blocked by
 * CSP), so createFabFile hands the browser this same-origin route instead. It reads the request
 * body as a size-capped stream, buffers it, then writes it to storage under the FabFile's own key
 * (the storage upload takes a Buffer) and marks the FabFile complete - the PUT completing proves
 * the object landed. The MinIO ObjectCreated webhook still fires to enqueue chunking; marking
 * complete here (not only in the webhook) is what lets the safety-net scan
 * (server/worker/chunkScan.ts) recover a truly-lost webhook, since that scan only rescues
 * status:'complete' files.
 *
 * Auth is normal baseApi (the caller is the logged-in user / API key), so no capability token is
 * needed - but the target FabFile must exist, belong to the caller, and still be awaiting upload.
 * Self-host only (404 otherwise).
 */

const DEFAULT_MAX_FILE_SIZE_MB = 20; // mirror fabFileService/create.ts
/** Coarse Content-Length pre-check ceiling; the exact MaxFileSize cap is enforced mid-stream. */
const BODY_CEILING_BYTES = 512 * 1024 * 1024;

const handler = baseApi({ maxBodySize: BODY_CEILING_BYTES }).put(
  asyncHandler(async (req: Request, res: Response) => {
    if (process.env.B4M_SELF_HOST !== 'true') {
      return res.status(404).json({ error: 'Not found' });
    }

    const fabFileId = String((req.query as { id?: string }).id ?? '');
    const fabFile = await FabFile.findById(fabFileId);
    // Same 404 for missing and not-owned so the route doesn't leak which files exist.
    if (!fabFile || fabFile.userId !== req.user.id) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (fabFile.status !== 'pending') {
      return res.status(400).json({ error: 'File is not awaiting upload' });
    }
    if (!fabFile.filePath) {
      return res.status(400).json({ error: 'File has no storage path' });
    }
    const filePath = fabFile.filePath;

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

    // Write to the FabFile's own storage key (from the DB, never client-supplied) so the caller
    // can't target an arbitrary key and the webhook fires on the expected object.
    await getFilesStorage().upload(body, filePath, {
      ContentType: fabFile.mimeType || (req.headers['content-type'] as string) || 'application/octet-stream',
      ContentLength: body.length,
    });

    // A successful write proves the object landed, so mark complete here rather than depending on
    // the webhook. A lost webhook then only skips the chunk enqueue, which the safety-net scan
    // recovers; the webhook's own status write (when it arrives) is an idempotent no-op.
    fabFile.status = 'complete';
    await fabFile.save();

    return res.status(200).json({ ok: true, fabFileId: fabFile.id });
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
