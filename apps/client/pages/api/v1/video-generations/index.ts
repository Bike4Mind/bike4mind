/**
 * POST /api/v1/video-generations - start a video generation job (202).
 * GET  /api/v1/video-generations - list the caller's jobs.
 *
 * Auth, scope and body validation come from the contracts; the job lifecycle lives in createVideoJob and the
 * generation-job engine. Every response renders through toPublicVideoGeneration.
 */
import {
  createVideoGenerationContract,
  GENERATION_JOB_ID_PATTERN,
  listVideoGenerationsContract,
  getVideoModelCapabilities,
  NotFoundError,
  UnprocessableEntityError,
  VideoModelIdSchema,
  type CreateVideoGenerationBody,
  type GenerationJobSource,
  type VideoGenerationRequest,
} from '@bike4mind/common';
import { generationJobRepository } from '@bike4mind/database';
import { createVideoJob, type CreateVideoJobResult } from '@bike4mind/services/videoJobs';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { getCreateVideoJobDeps } from '@server/generationJobs/wiring';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { resolveBillingOrgId } from '@server/utils/orgAccess';
import { mapperDeps, perUserRateLimit } from '@server/videoGenerations/routeDeps';
import { toPublicVideoGeneration } from '@server/videoGenerations/toPublicVideoGeneration';

const CURSOR_SCOPE = 'v1.video-generations';

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
  // 'studio' means any first-party session (the SPA), not only the Studio page; an API key is the public API.
  // Idempotency keys are scoped per source, so the same key sent from both is two different requests.
  const source: GenerationJobSource = isApiKeyAuth(req) ? 'api' : 'studio';
  // createVideoJob refuses a keyless provider itself, after its idempotent replay lookup.
  const result = await createVideoJob(
    {
      user: { id: req.user.id, organizationId: await resolveBillingOrgId(req, undefined) },
      request,
      source,
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
  const { limit, cursor, state, source } = req.validatedQuery;
  const beforeId = cursor === undefined ? undefined : decodeCursor(cursor, CURSOR_SCOPE);
  // A decoded id is client-controlled; keep a malformed one away from Mongo (it would be a BSON 500).
  if (beforeId !== undefined && !GENERATION_JOB_ID_PATTERN.test(beforeId)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }
  // One extra row tells whether another page exists without a count query.
  const rows = await generationJobRepository.listByRequester({
    requestedBy: req.user.id,
    kind: 'video',
    state,
    source,
    beforeId,
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(CURSOR_SCOPE, page[page.length - 1].id) : null;
  const data = await Promise.all(page.map(job => toPublicVideoGeneration(job, mapperDeps)));
  return res.json({ data, next_cursor: nextCursor });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRouter, POST: createRouter });
