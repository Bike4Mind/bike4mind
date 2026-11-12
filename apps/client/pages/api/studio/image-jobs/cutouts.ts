/**
 * POST /api/studio/image-jobs/cutouts - remove the background of one of the caller's images (a product shot); 202
 * with the job. The cutout is a transparent PNG saved to Files with `derivedFrom` -> the original, and Studio sends it
 * as the reference instead. Billed like any image job (hold at create, settle on delivery, refund on failure).
 *
 * Studio only: a signed-in session behind EnableStudioImage, like the image-jobs route. The model, prompt and canvas
 * are server-chosen (createCutoutJob), so the body is only the file.
 */
import { z } from 'zod';
import { createCutoutJob } from '@bike4mind/services/imageJobs';
import { requireStudioFeature } from '@bike4mind/server-utils/middlewares/studioFeatureFlag';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { getCreateImageJobsDeps } from '@server/generationJobs/wiring';
import { imageJobRefusalBody, toStudioImageJob } from '@server/generationJobs/studioImageJobResponse';
import { readIdempotencyKey } from '@server/generations/readIdempotencyKey';

const BodySchema = z.strictObject({
  fileId: z.string().regex(/^[0-9a-f]{24}$/),
});

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireStudioFeature('image'))
  .post(
    perUserRateLimit('POST /api/studio/image-jobs/cutouts'),
    asyncHandler(async (req, res) => {
      assertAiAccessAllowed(req.user);
      const body = BodySchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ error: 'invalid_request', message: 'Body must be { fileId }' });
      }
      const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);
      // undefined: bill the caller's active organization, as the image-jobs route does.
      const organizationId = await resolveMediaBillingOrgId(req, undefined);
      const result = await createCutoutJob(
        {
          user: { id: req.user.id, organizationId },
          fileId: body.data.fileId,
          source: 'studio',
          // Its own scope, so a key never replays a plain image job.
          ...(idempotencyKey && { idempotencyKey: `studio:image-cutout:${req.user.id}:${idempotencyKey}` }),
        },
        getCreateImageJobsDeps()
      );
      if (!result.ok) return res.status(result.status).json(imageJobRefusalBody(result));
      return res.status(result.created ? 202 : 200).json({ job: toStudioImageJob(result.jobs[0]) });
    })
  );

export const config = {
  api: { externalResolver: true },
};

export default handler;
