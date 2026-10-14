/**
 * POST /api/v1/music-generations - start a music generation job (202).
 * GET  /api/v1/music-generations - list the caller's jobs.
 *
 * Auth, scope and body validation come from the contracts; the job lifecycle lives in createMusicJob and the
 * generation-job engine. Every response renders through toPublicMusicGeneration.
 */
import {
  createMusicGenerationContract,
  listMusicGenerationsContract,
  MusicModelIdSchema,
  UnprocessableEntityError,
  type CreateMusicGenerationBody,
  type GenerationJobSource,
  type MusicGenerationRequest,
} from '@bike4mind/common';
import { createMusicJob, type CreateMusicJobResult } from '@bike4mind/services/musicJobs';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { getCreateMusicJobDeps } from '@server/generationJobs/wiring';
import { listOwnGenerationJobs } from '@server/generations/listOwnGenerationJobs';
import { readIdempotencyKey } from '@server/generations/readIdempotencyKey';
import { resolveBillingOrgId } from '@server/utils/orgAccess';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { toPublicMusicGeneration } from '@server/musicGenerations/toPublicMusicGeneration';

const CURSOR_SCOPE = 'v1.music-generations';

// Omitted fields stay omitted: createMusicJob resolves the model's defaults and validates its capabilities.
const toDomainRequest = (body: CreateMusicGenerationBody): MusicGenerationRequest => {
  const model = MusicModelIdSchema.safeParse(body.model);
  if (!model.success) {
    throw new UnprocessableEntityError(`Unknown music model: ${body.model}`, { errorCode: 'model_unavailable' });
  }
  return {
    model: model.data,
    prompt: body.prompt,
    ...(body.lyrics !== undefined && { lyrics: body.lyrics }),
    ...(body.instrumental !== undefined && { instrumental: body.instrumental }),
    ...(body.duration_seconds !== undefined && { durationSeconds: body.duration_seconds }),
  };
};

// CONVENTIONS allow no 400 or 402, so every refusal is a 422; the storage code takes the public name the Files
// upload routes already use for the same condition.
const toHttpError = (refusal: Extract<CreateMusicJobResult, { ok: false }>) =>
  new UnprocessableEntityError(refusal.message, {
    errorCode: refusal.code === 'storage_quota_exceeded' ? 'storage_limit_exceeded' : refusal.code,
  });

const createRouter = nextRouteForContract(createMusicGenerationContract, {
  rateLimit: perUserRateLimit('POST /api/v1/music-generations'),
}).post(async (req, res) => {
  const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);
  const request = toDomainRequest(req.validated);
  // As in video-generations: 'studio' is any first-party session, and idempotency keys are scoped per source.
  const source: GenerationJobSource = isApiKeyAuth(req) ? 'api' : 'studio';
  const organizationId = await resolveBillingOrgId(req, req.validated.organization_id);
  const result = await createMusicJob(
    {
      user: { id: req.user.id, organizationId },
      request,
      source,
      ...(idempotencyKey && { idempotencyKey: `${source}:${req.user.id}:${idempotencyKey}` }),
    },
    getCreateMusicJobDeps()
  );
  if (!result.ok) throw toHttpError(result);
  return res.status(202).json(await toPublicMusicGeneration(result.job, mapperDeps));
});

const listRouter = nextRouteForContract(listMusicGenerationsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/music-generations'),
}).get(async (req, res) => {
  const { jobs, nextCursor } = await listOwnGenerationJobs({
    ...req.validatedQuery,
    userId: req.user.id,
    kind: 'music',
    cursorScope: CURSOR_SCOPE,
  });
  const data = await Promise.all(jobs.map(job => toPublicMusicGeneration(job, mapperDeps)));
  return res.json({ data, next_cursor: nextCursor });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRouter, POST: createRouter });
