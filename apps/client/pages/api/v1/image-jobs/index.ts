/**
 * POST /api/v1/image-jobs - start `count` image jobs sharing a group id (202).
 * GET  /api/v1/image-jobs - list the caller's image jobs.
 *
 * Auth, scope and body validation come from the contracts; validation against the model, billing and the job
 * lifecycle live in createImageJobs and the generation-job engine. Every job renders through toPublicGenerationJob.
 */
import {
  createImageJobContract,
  ImageJobRequestSchema,
  listImageJobsContract,
  StorageLimitError,
  UnprocessableEntityError,
  type CreateImageJobBody,
  type GenerationJobSource,
  type ImageJobApiErrorCode,
  type ImageJobRequest,
} from '@bike4mind/common';
import { createImageJobs, type CreateImageJobsResult } from '@bike4mind/services/imageJobs';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { getCreateImageJobsDeps } from '@bike4mind/server-utils/generationJobs/wiring';
import { listOwnGenerationJobs } from '@server/generations/listOwnGenerationJobs';
import { readIdempotencyKey } from '@server/generations/readIdempotencyKey';
import { adminRoleWithheldFor } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { IMAGE_GENERATION_PROJECTION, toPublicGenerationJob } from '@server/generations/toPublicGenerationJob';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';

const CURSOR_SCOPE = 'v1.image-jobs';

// Omitted fields stay omitted: createImageJobs resolves the model's defaults and checks its capabilities.
const toDomainRequest = (body: CreateImageJobBody): ImageJobRequest => {
  const model = ImageJobRequestSchema.shape.model.safeParse(body.model);
  if (!model.success) {
    throw new UnprocessableEntityError(`Unknown image model: ${body.model}`, { errorCode: 'model_unavailable' });
  }
  return {
    model: model.data,
    mode: body.mode,
    prompt: body.prompt,
    ...(body.inputs && { inputs: body.inputs.map(input => ({ role: input.role, fileId: input.file_id })) }),
    ...(body.size !== undefined && { size: body.size }),
    ...(body.aspect_ratio !== undefined && { aspectRatio: body.aspect_ratio }),
    ...(body.quality !== undefined && { quality: body.quality }),
    ...(body.output_format !== undefined && { outputFormat: body.output_format }),
    ...(body.transparent_background !== undefined && { transparentBackground: body.transparent_background }),
    ...(body.seed !== undefined && { seed: body.seed }),
    ...(body.edit_regions && { editRegions: body.edit_regions }),
  };
};

const toErrorCode = (refusal: Extract<CreateImageJobsResult, { ok: false }>): ImageJobApiErrorCode => {
  if (refusal.code === 'unsupported_by_model') return refusal.failures[0].code;
  // The contract bounds count, so this only means the service cap moved without IMAGE_JOB_COUNT_MAX.
  if (refusal.code === 'invalid_count') return 'invalid_request';
  return refusal.code;
};

// The storage refusal is a 400 like the Files routes' storage_limit_exceeded; every other refusal is a 422 (no
// 402), matching video- and music-generations.
const toHttpError = (refusal: Extract<CreateImageJobsResult, { ok: false }>) => {
  if (refusal.code === 'storage_quota_exceeded') return new StorageLimitError(refusal.message, refusal.storage);
  const message =
    refusal.code === 'unsupported_by_model'
      ? refusal.failures.map(failure => failure.message).join('; ')
      : refusal.message;
  return new UnprocessableEntityError(message, { errorCode: toErrorCode(refusal) });
};

const createRouter = nextRouteForContract(createImageJobContract, {
  rateLimit: perUserRateLimit('POST /api/v1/image-jobs'),
}).post(async (req, res) => {
  assertAiAccessAllowed(req.user);
  const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);
  const request = toDomainRequest(req.validated);
  // As in video-generations: 'studio' is any first-party session, and idempotency keys are scoped per source.
  const source: GenerationJobSource = isApiKeyAuth(req) ? 'api' : 'studio';
  // An org-billed API key bills its org; otherwise null = personal, undefined = the caller's own org.
  const organizationId = await resolveMediaBillingOrgId(req, req.validated.organization_id);
  const result = await createImageJobs(
    {
      user: { id: req.user.id, organizationId, adminRoleWithheld: adminRoleWithheldFor(req.apiKeyInfo) },
      request,
      count: req.validated.count ?? 1,
      source,
      apiKeyId: req.apiKeyInfo?.keyId,
      // The namespace is shared on purpose with the Studio image route (`studio:image:<user>:<key>`): for a JWT caller
      // it is the same user and the same createImageJobs, so a retry across the two replays rather than double-bills.
      ...(idempotencyKey && { idempotencyKey: `${source}:image:${req.user.id}:${idempotencyKey}` }),
    },
    getCreateImageJobsDeps()
  );
  if (!result.ok) throw toHttpError(result);
  const data = await Promise.all(
    result.jobs.map(job => toPublicGenerationJob(job, mapperDeps, IMAGE_GENERATION_PROJECTION))
  );
  return res.status(202).json({ group_id: result.groupId, data });
});

const listRouter = nextRouteForContract(listImageJobsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/image-jobs'),
}).get(async (req, res) => {
  const { jobs, nextCursor } = await listOwnGenerationJobs({
    ...req.validatedQuery,
    userId: req.user.id,
    kind: 'image',
    cursorScope: CURSOR_SCOPE,
  });
  const data = await Promise.all(jobs.map(job => toPublicGenerationJob(job, mapperDeps, IMAGE_GENERATION_PROJECTION)));
  return res.json({ data, next_cursor: nextCursor });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRouter, POST: createRouter });
