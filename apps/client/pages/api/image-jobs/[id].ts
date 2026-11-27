/**
 * GET /api/image-jobs/:id - one image job the caller requested, or one made in a notebook the caller can read
 * (findReadableGenerationJob), as the chat job card reads it; anything else is a 404.
 *
 * Internal: a signed-in session (no API key) and not behind the Studio flag, since chat's image tools start these
 * jobs for everyone. The shape is the published image job's, but error codes are not folded (IMAGE_JOB_CARD_PROJECTION).
 */
import type { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { findReadableGenerationJob } from '@server/generations/findReadableGenerationJob';
import { mapperDeps } from '@server/generations/routeDeps';
import { IMAGE_JOB_CARD_PROJECTION, toPublicGenerationJob } from '@server/generations/toPublicGenerationJob';

const handler = baseApi({ auth: 'jwtOnly' }).get(
  perUserRateLimit('GET /api/image-jobs/[id]'),
  async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const job = await findReadableGenerationJob(String(req.query.id), req.user, 'image');
    if (!job) return res.status(404).json({ error: 'not_found', message: 'Image generation not found' });
    const resource = await toPublicGenerationJob(job, mapperDeps, IMAGE_JOB_CARD_PROJECTION);
    // Billing belongs to the requester; notebook readers see the job without it.
    if (job.requestedBy !== req.user.id) return res.json({ ...resource, credits: { reserved: null, settled: null } });
    return res.json(resource);
  }
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
