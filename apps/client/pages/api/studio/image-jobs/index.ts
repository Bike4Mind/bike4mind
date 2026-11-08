/**
 * POST /api/studio/image-jobs - start `count` image jobs that share a groupId ("make N"); 202 with the jobs.
 * GET  /api/studio/image-jobs - the caller's image jobs, newest first.
 *
 * Studio only: a signed-in session (no API key) behind the EnableStudioImage flag, so there is no public contract.
 * Validation, billing and the job lifecycle live in createImageJobs and the generation-job engine. A request the
 * model cannot honour answers 422 with every why-not reason, so Studio can show them next to the fields.
 */
import { z } from 'zod';
import type { IGenerationJobDocumentOf } from '@bike4mind/common';
import { createImageJobs, type CreateImageJobsResult } from '@bike4mind/services/imageJobs';
import { requireStudioFeature } from '@bike4mind/server-utils/middlewares/studioFeatureFlag';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { getCreateImageJobsDeps } from '@server/generationJobs/wiring';
import { listOwnGenerationJobs } from '@server/generations/listOwnGenerationJobs';
import { readIdempotencyKey } from '@server/generations/readIdempotencyKey';

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

type ImageJob = IGenerationJobDocumentOf<'image'>;

/** The fields Studio reads; credit holds, provider errors and lease state stay server-side. */
const toStudioImageJob = (job: ImageJob) => ({
  id: job.id,
  groupId: job.payload.groupId ?? null,
  state: job.state,
  request: job.payload.request,
  error: job.error ? { code: job.error.code, message: job.error.message } : null,
  output: job.payload.output
    ? {
        fileId: job.payload.output.fileId ?? null,
        contentType: job.payload.output.contentType,
        bytes: job.payload.output.bytes,
      }
    : null,
  createdAt: job.createdAt,
});

const refusalBody = (refusal: Extract<CreateImageJobsResult, { ok: false }>) => ({
  error: refusal.code,
  message: refusal.message,
  ...(refusal.code === 'unsupported_by_model' && { failures: refusal.failures }),
  ...(refusal.code === 'storage_quota_exceeded' && { storage: refusal.storage }),
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
          // Scoped like the media routes' keys, so one user's key never collides with another's.
          ...(idempotencyKey && { idempotencyKey: `studio:${req.user.id}:${idempotencyKey}` }),
        },
        getCreateImageJobsDeps()
      );
      if (!result.ok) return res.status(result.status).json(refusalBody(result));
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
