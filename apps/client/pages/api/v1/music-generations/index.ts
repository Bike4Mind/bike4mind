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
  StorageLimitError,
  UnprocessableEntityError,
  type CreateMusicGenerationBody,
  type GenerationJobSource,
  type MusicGenerationApiErrorCode,
  type MusicGenerationRequest,
} from '@bike4mind/common';
import { createMusicJob, type CreateMusicJobResult } from '@bike4mind/services/musicJobs';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { getCreateMusicJobDeps } from '@server/generationJobs/wiring';
import { listOwnGenerationJobs } from '@server/generations/listOwnGenerationJobs';
import { readIdempotencyKey } from '@server/generations/readIdempotencyKey';
import { adminRoleWithheldFor } from '@server/auth/apiKeyAdminScope';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { toPublicMusicGeneration } from '@server/musicGenerations/toPublicMusicGeneration';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';

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

// The storage refusal is a 400 like the Files routes' storage_limit_exceeded; every other refusal is a 422 (no
// 402), matching video-generations. The errorCode type keeps every service code a published MusicGenerationApiErrorCode.
const toHttpError = (refusal: Extract<CreateMusicJobResult, { ok: false }>) => {
  if (refusal.code === 'storage_quota_exceeded') return new StorageLimitError(refusal.message, refusal.storage);
  const errorCode: MusicGenerationApiErrorCode = refusal.code;
  return new UnprocessableEntityError(refusal.message, { errorCode });
};

const createRouter = nextRouteForContract(createMusicGenerationContract, {
  rateLimit: perUserRateLimit('POST /api/v1/music-generations'),
}).post(async (req, res) => {
  assertAiAccessAllowed(req.user);
  const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);
  const request = toDomainRequest(req.validated);
  // As in video-generations: 'studio' is any first-party session, and idempotency keys are scoped per source.
  const source: GenerationJobSource = isApiKeyAuth(req) ? 'api' : 'studio';
  // An org-billed API key bills its org; otherwise null = personal, undefined = the caller's own org.
  const organizationId = await resolveMediaBillingOrgId(req, req.validated.organization_id);
  const result = await createMusicJob(
    {
      user: { id: req.user.id, organizationId, adminRoleWithheld: adminRoleWithheldFor(req.apiKeyInfo) },
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
