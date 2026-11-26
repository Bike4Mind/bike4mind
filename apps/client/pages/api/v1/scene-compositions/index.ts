/**
 * POST /api/v1/scene-compositions - compose a Scene (a video and a music track muxed into one clip) as a job (202).
 * GET  /api/v1/scene-compositions - list the caller's jobs.
 *
 * Auth, scope and body validation come from the contracts; the job lifecycle lives in createSceneCompositionJob and
 * the generation-job engine. Every response renders through toPublicGenerationJob.
 */
import {
  createSceneCompositionContract,
  listSceneCompositionsContract,
  NotFoundError,
  StorageLimitError,
  UnprocessableEntityError,
  type CreateSceneCompositionBody,
  type GenerationJobSource,
  type SceneCompositionApiErrorCode,
  type SceneCompositionRequest,
} from '@bike4mind/common';
import { createSceneCompositionJob, type CreateSceneCompositionJobResult } from '@bike4mind/services/sceneJobs';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { getCreateSceneCompositionJobDeps } from '@bike4mind/server-utils/generationJobs/wiring';
import { limitInputFilesForKey } from '@bike4mind/server-utils/files/generateKeyInputs';
import { listOwnGenerationJobs } from '@server/generations/listOwnGenerationJobs';
import { readIdempotencyKey } from '@server/generations/readIdempotencyKey';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { SCENE_COMPOSITION_PROJECTION, toPublicGenerationJob } from '@server/generations/toPublicGenerationJob';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';

const CURSOR_SCOPE = 'v1.scene-compositions';

// File ids are lowercased: FabFile lineage only accepts lowercase hex. Omitted audio fields stay omitted;
// createSceneCompositionJob resolves their defaults.
const toDomainRequest = (body: CreateSceneCompositionBody): SceneCompositionRequest => ({
  videoFileId: body.video_file_id.toLowerCase(),
  audioFileId: body.audio_file_id.toLowerCase(),
  ...(body.cover_file_id !== undefined && { coverFileId: body.cover_file_id.toLowerCase() }),
  ...(body.audio !== undefined && {
    audio: {
      ...(body.audio.fit !== undefined && { fit: body.audio.fit }),
      ...(body.audio.fade_in_seconds !== undefined && { fadeInSeconds: body.audio.fade_in_seconds }),
      ...(body.audio.fade_out_seconds !== undefined && { fadeOutSeconds: body.audio.fade_out_seconds }),
    },
  }),
  ...(body.title !== undefined && { title: body.title }),
});

// The errorCode type keeps every service code a published SceneCompositionApiErrorCode.
const toHttpError = (refusal: Extract<CreateSceneCompositionJobResult, { ok: false }>) => {
  if (refusal.code === 'storage_quota_exceeded') return new StorageLimitError(refusal.message, refusal.storage);
  const errorCode: SceneCompositionApiErrorCode = refusal.code;
  return refusal.status === 404
    ? new NotFoundError(refusal.message, { errorCode })
    : new UnprocessableEntityError(refusal.message, { errorCode });
};

const createRouter = nextRouteForContract(createSceneCompositionContract, {
  rateLimit: perUserRateLimit('POST /api/v1/scene-compositions'),
}).post(async (req, res) => {
  // Free in v1, but still a generation: a blocked account may not start one.
  assertAiAccessAllowed(req.user);
  const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);
  // As in music-generations: 'studio' is any first-party session, and idempotency keys are scoped per source.
  const source: GenerationJobSource = isApiKeyAuth(req) ? 'api' : 'studio';
  // Nothing is billed; the owner only scopes the idempotency key, by the same rule as the other generation kinds.
  const organizationId = await resolveMediaBillingOrgId(req, undefined);
  const deps = getCreateSceneCompositionJobDeps();
  const sceneDeps = { ...deps, loadInputFile: limitInputFilesForKey(req, deps.loadInputFile) };
  const result = await createSceneCompositionJob(
    {
      user: { id: req.user.id, organizationId },
      request: toDomainRequest(req.validated),
      source,
      apiKeyId: req.apiKeyInfo?.keyId,
      ...(idempotencyKey && { idempotencyKey: `${source}:${req.user.id}:${idempotencyKey}` }),
    },
    sceneDeps
  );
  if (!result.ok) throw toHttpError(result);
  return res.status(202).json(await toPublicGenerationJob(result.job, mapperDeps, SCENE_COMPOSITION_PROJECTION));
});

const listRouter = nextRouteForContract(listSceneCompositionsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/scene-compositions'),
}).get(async (req, res) => {
  const { jobs, nextCursor } = await listOwnGenerationJobs({
    ...req.validatedQuery,
    userId: req.user.id,
    kind: 'compose',
    cursorScope: CURSOR_SCOPE,
  });
  const data = await Promise.all(jobs.map(job => toPublicGenerationJob(job, mapperDeps, SCENE_COMPOSITION_PROJECTION)));
  return res.json({ data, next_cursor: nextCursor });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRouter, POST: createRouter });
