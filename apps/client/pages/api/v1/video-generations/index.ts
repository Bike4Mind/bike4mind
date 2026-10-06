/**
 * POST /api/v1/video-generations - start a video generation job (202).
 * GET  /api/v1/video-generations - list the caller's jobs (added with the list contract).
 *
 * Auth, scope and body validation come from the contracts; the job lifecycle lives in createVideoJob and the
 * generation-job engine. Every response renders through toPublicVideoGeneration.
 */
import {
  createVideoGenerationContract,
  getVideoModelCapabilities,
  NotFoundError,
  UnprocessableEntityError,
  VideoModelIdSchema,
  type CreateVideoGenerationBody,
  type VideoGenerationRequest,
} from '@bike4mind/common';
import { createVideoJob, type CreateVideoJobResult } from '@bike4mind/services/videoJobs';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { getCreateVideoJobDeps } from '@server/generationJobs/wiring';
import { hasUsableKey } from '@server/videoGenerations/listUsableVideoModels';
import { mapperDeps, perUserRateLimit } from '@server/videoGenerations/routeDeps';
import { toPublicVideoGeneration } from '@server/videoGenerations/toPublicVideoGeneration';

const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,255}$/;

const readIdempotencyKey = (header: string | string[] | undefined): string | undefined => {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new UnprocessableEntityError('Idempotency-Key must be 1-255 printable ASCII characters', {
      errorCode: 'invalid_idempotency_key',
    });
  }
  return header;
};

// Omitted fields take the model's catalog defaults; createVideoJob then validates against its capabilities.
const toDomainRequest = (body: CreateVideoGenerationBody): VideoGenerationRequest => {
  const model = VideoModelIdSchema.safeParse(body.model);
  if (!model.success) {
    throw new UnprocessableEntityError(`Unknown video model: ${body.model}`, { errorCode: 'model_unavailable' });
  }
  const { defaults } = getVideoModelCapabilities(model.data);
  return {
    model: model.data,
    mode: body.mode ?? (body.input_image_file_id ? 'image_to_video' : 'text_to_video'),
    prompt: body.prompt,
    durationSeconds: body.duration_seconds ?? defaults.durationSeconds,
    aspectRatio: body.aspect_ratio ?? defaults.aspectRatio,
    resolution: body.resolution ?? defaults.resolution,
    ...(body.input_image_file_id && { inputImageFileId: body.input_image_file_id }),
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
  const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);
  const request = toDomainRequest(req.validated);
  const deps = getCreateVideoJobDeps();
  const caps = getVideoModelCapabilities(request.model);
  // An unregistered provider is reported by createVideoJob; a missing key would otherwise fail only at submit.
  if (deps.providers.get(caps.provider) && !(await hasUsableKey(caps.provider, req.user.id, deps))) {
    throw new UnprocessableEntityError(`${caps.displayName} has no API key configured`, {
      errorCode: 'model_unavailable',
    });
  }
  const result = await createVideoJob(
    {
      user: { id: req.user.id, organizationId: req.user.organizationId ?? null },
      request,
      source: 'api',
      // The domain scopes keys per credit owner (the org for members); per user here keeps members apart.
      ...(idempotencyKey && { idempotencyKey: `api:${req.user.id}:${idempotencyKey}` }),
    },
    deps
  );
  if (!result.ok) throw toHttpError(result);
  return res.status(202).json(await toPublicVideoGeneration(result.job, mapperDeps));
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ POST: createRouter });
