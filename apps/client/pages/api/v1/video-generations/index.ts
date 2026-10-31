/**
 * POST /api/v1/video-generations - start a video generation job (202).
 * GET  /api/v1/video-generations - list the caller's jobs.
 *
 * Auth, scope and body validation come from the contracts; the job lifecycle lives in createVideoJob and the
 * generation-job engine. Every response renders through toPublicVideoGeneration.
 */
import {
  createVideoGenerationContract,
  listVideoGenerationsContract,
  getVideoModelCapabilities,
  NotFoundError,
  UnprocessableEntityError,
  VideoModelIdSchema,
  videoRequestInputs,
  type CreateVideoGenerationBody,
  type GenerationJobSource,
  type VideoGenerationRequest,
} from '@bike4mind/common';
import { createVideoJob, type CreateVideoJobResult } from '@bike4mind/services/videoJobs';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { getCreateVideoJobDeps } from '@server/generationJobs/wiring';
import { listOwnGenerationJobs } from '@server/generations/listOwnGenerationJobs';
import { readIdempotencyKey } from '@server/generations/readIdempotencyKey';
import { adminRoleWithheldFor } from '@server/auth/apiKeyAdminScope';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { toPublicVideoGeneration } from '@server/videoGenerations/toPublicVideoGeneration';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';

const CURSOR_SCOPE = 'v1.video-generations';

// The legacy field passes through as-is rather than becoming inputs: an idempotent retry is matched against the
// stored request byte for byte, so rewriting it would turn a retry of a pre-`inputs` job into a 409.
const toDomainInputs = (
  body: CreateVideoGenerationBody
): Pick<VideoGenerationRequest, 'inputs' | 'inputImageFileId'> => {
  if (body.inputs && body.input_image_file_id) {
    throw new UnprocessableEntityError('Send inputs or input_image_file_id, not both', {
      errorCode: 'unexpected_input_image',
    });
  }
  if (body.input_image_file_id) return { inputImageFileId: body.input_image_file_id };
  if (body.inputs) return { inputs: body.inputs.map(input => ({ role: input.role, fileId: input.file_id })) };
  return {};
};

// Omitted fields take the model's catalog defaults; createVideoJob then validates against its capabilities.
const toDomainRequest = (body: CreateVideoGenerationBody): VideoGenerationRequest => {
  const model = VideoModelIdSchema.safeParse(body.model);
  if (!model.success) {
    throw new UnprocessableEntityError(`Unknown video model: ${body.model}`, { errorCode: 'model_unavailable' });
  }
  const { defaults } = getVideoModelCapabilities(model.data);
  const inputs = toDomainInputs(body);
  const hasFirstFrame = videoRequestInputs(inputs).some(input => input.role === 'first_frame');
  return {
    model: model.data,
    mode: body.mode ?? (hasFirstFrame ? 'image_to_video' : 'text_to_video'),
    prompt: body.prompt,
    durationSeconds: body.duration_seconds ?? defaults.durationSeconds,
    aspectRatio: body.aspect_ratio ?? defaults.aspectRatio,
    resolution: body.resolution ?? defaults.resolution,
    ...inputs,
    ...(body.audio !== undefined && { audio: body.audio }),
  };
};

// CONVENTIONS allow no 402 and the contract publishes every refusal but a missing image as a 422.
const toHttpError = (refusal: Extract<CreateVideoJobResult, { ok: false }>) =>
  refusal.status === 404
    ? new NotFoundError(refusal.message, { errorCode: refusal.code })
    : new UnprocessableEntityError(refusal.message, { errorCode: refusal.code });

const createRouter = nextRouteForContract(createVideoGenerationContract, {
  rateLimit: perUserRateLimit('POST /api/v1/video-generations'),
}).post(async (req, res) => {
  assertAiAccessAllowed(req.user);
  const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);
  const request = toDomainRequest(req.validated);
  // 'studio' means any first-party session (the SPA), not only the Studio page; an API key is the public API.
  // Idempotency keys are scoped per source, so the same key sent from both is two different requests.
  const source: GenerationJobSource = isApiKeyAuth(req) ? 'api' : 'studio';
  // An org-billed API key bills its org; otherwise null = personal, undefined = the caller's own org.
  const organizationId = await resolveMediaBillingOrgId(req, req.validated.organization_id);
  // createVideoJob refuses a keyless provider itself, after its idempotent replay lookup.
  const result = await createVideoJob(
    {
      user: { id: req.user.id, organizationId, adminRoleWithheld: adminRoleWithheldFor(req.apiKeyInfo) },
      request,
      source,
      apiKeyId: req.apiKeyInfo?.keyId,
      // The domain scopes keys per credit owner (the org for members): per user keeps members apart, and per
      // source keeps a studio retry from replaying an API job that reused the same key.
      ...(idempotencyKey && { idempotencyKey: `${source}:${req.user.id}:${idempotencyKey}` }),
    },
    getCreateVideoJobDeps()
  );
  if (!result.ok) throw toHttpError(result);
  return res.status(202).json(await toPublicVideoGeneration(result.job, mapperDeps));
});

const listRouter = nextRouteForContract(listVideoGenerationsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/video-generations'),
}).get(async (req, res) => {
  const { jobs, nextCursor } = await listOwnGenerationJobs({
    ...req.validatedQuery,
    userId: req.user.id,
    kind: 'video',
    cursorScope: CURSOR_SCOPE,
  });
  const data = await Promise.all(jobs.map(job => toPublicVideoGeneration(job, mapperDeps)));
  return res.json({ data, next_cursor: nextCursor });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRouter, POST: createRouter });
