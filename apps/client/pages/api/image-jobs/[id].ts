/**
 * GET /api/image-jobs/:id - one image job the caller requested, or one made in a notebook the caller can read
 * (findReadableGenerationJob), as the chat job card reads it; anything else is a 404.
 *
 * Internal: a signed-in session (no API key) and not behind the Studio flag, since chat's image tools start these
 * jobs for everyone. The shape is toPublicGenerationJob's, so the published per-id resource can reuse it unchanged.
 */
import type { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { findReadableGenerationJob } from '@server/generations/findReadableGenerationJob';
import { mapperDeps } from '@server/generations/routeDeps';
import { IMAGE_GENERATION_PROJECTION, toPublicGenerationJob } from '@server/generations/toPublicGenerationJob';

const handler = baseApi({ auth: 'jwtOnly' }).get(
  perUserRateLimit('GET /api/image-jobs/[id]'),
  async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const job = await findReadableGenerationJob(String(req.query.id), req.user, 'image');
    if (!job) return res.status(404).json({ error: 'not_found', message: 'Image generation not found' });
    return res.json(await toPublicGenerationJob(job, mapperDeps, IMAGE_GENERATION_PROJECTION));
  }
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
