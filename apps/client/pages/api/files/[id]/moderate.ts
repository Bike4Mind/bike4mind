import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { FILES_WRITE_SCOPES } from '@bike4mind/server-utils/files/fileScopes';
import { moderateFabFileNow } from '@server/files/moderateFabFileNow';
import type { Request, Response } from 'express';

/**
 * On-demand moderation scan for a file the caller has just uploaded (server/files/moderateFabFileNow.ts). Only call
 * it for files used immediately and discarded (like edit masks), never for durable uploads that would sit unscanned
 * until the rescue sweep.
 */
const handler = baseApi({ requiredScopes: FILES_WRITE_SCOPES }).post(
  asyncHandler(async (req: Request, res: Response) => {
    const outcome = await moderateFabFileNow({
      fabFileId: String((req.query as { id?: string }).id ?? ''),
      userId: req.user.id,
      logger: req.logger,
    });
    if (outcome.ok) return res.json({ moderationStatus: outcome.moderationStatus });
    // Same 404 for missing and not-owned so the route doesn't leak which files exist.
    if (outcome.reason === 'not_found') return res.status(404).json({ error: 'File not found' });
    return res.status(400).json({ error: 'File has no storage path' });
  })
);

export default handler;
