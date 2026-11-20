/**
 * POST /api/studio/image-jobs - start `count` image jobs that share a groupId ("make N"); 202 with the jobs.
 * GET  /api/studio/image-jobs - the caller's image jobs, newest first.
 *
 * Studio only: a signed-in session (no API key) behind the EnableStudioImage flag, so there is no public contract.
 * Validation, billing and the job lifecycle live in createImageJobs and the generation-job engine. A request the
 * model cannot honour answers 422 with every why-not reason, so Studio can show them next to the fields.
 */
import { z } from 'zod';
import { createImageJobs } from '@bike4mind/services/imageJobs';
import { requireStudioFeature } from '@bike4mind/server-utils/middlewares/studioFeatureFlag';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { getCreateImageJobsDeps } from '@bike4mind/server-utils/generationJobs/wiring';
import { listOwnGenerationJobs } from '@server/generations/listOwnGenerationJobs';
import { readIdempotencyKey } from '@server/generations/readIdempotencyKey';
import { imageJobRefusalBody, toStudioImageJob } from '@bike4mind/server-utils/generationJobs/studioImageJobResponse';

const CURSOR_SCOPE = 'studio.image-jobs';
const LIST_LIMIT_MAX = 100;

// The request itself is untrusted and parsed by createImageJobs, which owns its schema and the model checks.
const CreateBodySchema = z.strictObject({
  count: z.number(),
  request: z.unknown(),
});

const ListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(20),
  cursor: z.string().min(1).optional(),
});

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireStudioFeature('image'))
  .post(
    perUserRateLimit('POST /api/studio/image-jobs'),
    asyncHandler(async (req, res) => {
      assertAiAccessAllowed(req.user);
      const body = CreateBodySchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ error: 'invalid_request', message: 'Body must be { count, request }' });
      }
      const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);
      // undefined: bill the caller's active organization, as a first-party session does on every media route.
      const organizationId = await resolveMediaBillingOrgId(req, undefined);
      const result = await createImageJobs(
        {
          user: { id: req.user.id, organizationId },
          request: body.data.request,
          count: body.data.count,
          source: 'studio',
          // Scoped by surface, kind and user, so a key never collides across users or other Studio job kinds.
          ...(idempotencyKey && { idempotencyKey: `studio:image:${req.user.id}:${idempotencyKey}` }),
        },
        getCreateImageJobsDeps()
      );
      if (!result.ok) return res.status(result.status).json(imageJobRefusalBody(result));
      return res.status(result.created ? 202 : 200).json({
        groupId: result.groupId,
        jobs: result.jobs.map(toStudioImageJob),
      });
    })
  )
  .get(
    perUserRateLimit('GET /api/studio/image-jobs'),
    asyncHandler(async (req, res) => {
      const query = ListQuerySchema.safeParse(req.query);
      if (!query.success) return res.status(400).json({ error: 'invalid_request', message: 'Invalid query' });
      const { jobs, nextCursor } = await listOwnGenerationJobs({
        ...query.data,
        userId: req.user.id,
        kind: 'image',
        cursorScope: CURSOR_SCOPE,
      });
      return res.json({ data: jobs.map(toStudioImageJob), next_cursor: nextCursor });
    })
  );

export const config = {
  api: { externalResolver: true },
};

export default handler;
