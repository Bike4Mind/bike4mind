import { defineEndpoint } from '../defineEndpoint';
import { EXAMPLE_RESOURCE_ID, EXAMPLE_SESSION_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import { GenerateVideoRequestBodySchema } from '../../schemas/sora';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';
import {
  CreateVideoGenerationBodySchema,
  ListVideoGenerationsQuerySchema,
  ListVideoGenerationsResponseSchema,
  ListVideoModelsResponseSchema,
  VideoGenerationErrorResponseSchema,
  VideoGenerationIdParamSchema,
  VideoGenerationSchema,
} from '../../schemas/videoGenerations';
import { GenerateVideoResponseSchema, VideoQuestSchema } from '../../schemas/videoApi';
import {
  GENERATION_CALLBACK_DESCRIPTION,
  GENERATION_CALLBACK_REJECTED_DESCRIPTION,
} from '../../schemas/generationCallback';

/** The quest polled at `GET /api/v1/quests/{id}` after this endpoint's ACK. */
export const videoQuestPollResult = {
  schema: VideoQuestSchema,
  description:
    'The quest polled at `GET /api/v1/quests/{id}` after this ACK. The render is finished once `status` is ' +
    '`"done"`: on success `videos` holds the rendered videos; a render that FAILED is `type: "error"` with ' +
    'the reason in `reply`, never a 4xx. That covers credit exhaustion (tagged `errorCode: ' +
    '"insufficient_credits"`, the same vocabulary as the synchronous 422s on the audio endpoints) and a ' +
    'provider error. Check `type` before reading `videos`; `errorCode` is absent on unclassified failures, ' +
    'so its absence does not mean success.',
  example: {
    id: EXAMPLE_RESOURCE_ID,
    sessionId: EXAMPLE_SESSION_ID,
    status: 'done',
    type: 'message',
    videos: ['3f6c1a52-9d1e-4b7a-8c2f-5e0d4a9b1c7e.mp4'],
  },
} as const;

/**
 * Contract for POST /api/v1/video-generations. `/api/ai/generate-video` serves the
 * same handler as a legacy alias, like generateImage's.
 */
export const generateVideoContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/video-generations',
  operationId: 'generateVideo',
  summary: 'Generate a video',
  description:
    'Queues a Sora video generation and returns immediately with the quest that will carry the result - ' +
    'no video yet, and the call never blocks on the render. Poll `GET /api/v1/quests/{id}` until `status` is ' +
    '`"done"` (see the `generateVideo200PollResult` schema). Omit `sessionId` to create a new session. ' +
    'Credits are checked when the render runs, so insufficient credits arrive on the polled quest rather ' +
    'than as a 422. `POST /api/ai/generate-video` is a legacy alias of this endpoint. Authenticate with ' +
    'an API key (`b4m_live_`) or a JWT.\n\n' +
    GENERATION_CALLBACK_DESCRIPTION,
  tags: ['Videos'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: GenerateVideoRequestBodySchema,
  requestExample: { prompt: 'a drone shot over a foggy pine forest at sunrise', model: 'sora-2', seconds: 4 },
  responses: {
    200: {
      description:
        'Generation queued - NOT a finished render. `quest` has no videos yet; its outcome arrives on ' +
        '`GET /api/v1/quests/{id}`.',
      schema: GenerateVideoResponseSchema,
      pollResult: videoQuestPollResult,
    },
    400: { description: `The ${GENERATION_CALLBACK_REJECTED_DESCRIPTION}`, schema: ApiErrorSchema },
    404: {
      description:
        'The session, or the quest being retried, does not exist or is not accessible to the caller. A ' +
        'nonexistent billing `organizationId` is `404` only for an admin caller; for anyone else, an ' +
        'invalid or inaccessible `organizationId` is `403` instead.',
      schema: ApiErrorSchema,
    },
  },
  // Served by baseApi, so apiKeyRateLimit sets the windowed X-RateLimit-* headers.
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { prompt: 'a drone shot over a foggy pine forest at sunrise', model: 'sora-2', seconds: 4 },
  },
});

const exampleJob = {
  id: EXAMPLE_RESOURCE_ID,
  object: 'video_generation',
  state: 'pending',
  model: 'gemini-omni-1.1-flash',
  mode: 'text_to_video',
  prompt: 'A slow dolly shot of a red lighthouse at dusk',
  duration_seconds: 6,
  aspect_ratio: '16:9',
  resolution: '720p',
  source: 'api',
  progress: null,
  error: null,
  output: null,
  credits: { reserved: 6085, settled: null },
  created_at: '2026-10-06T00:00:00.000Z',
  updated_at: '2026-10-06T00:00:00.000Z',
} as const;

const scopeForbidden = { description: 'The API key lacks the `ai:generate` scope.', schema: ScopeForbiddenErrorSchema };
const notFound = {
  description: 'No video generation with that id was requested by the caller (a malformed id is also a 404).',
  schema: ApiErrorSchema,
};
const rateLimited = { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema };

export const listVideoModelsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/video-models',
  operationId: 'listVideoModels',
  summary: 'List the video models you can use',
  description:
    'Returns the video models that are enabled, available in this deployment and have a usable provider key ' +
    'for the caller, with their capabilities and per-second credit price. Validate requests against these ' +
    'capabilities: an unsupported duration, aspect ratio or resolution is a 422, never silently adjusted.',
  tags: ['Videos'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  responses: {
    200: { description: 'The usable models.', schema: ListVideoModelsResponseSchema },
    403: scopeForbidden,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const createVideoGenerationContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/video-generations',
  operationId: 'createVideoGeneration',
  summary: 'Start a video generation',
  description:
    'Queues a video generation and returns `202` with the job. Poll `GET /api/v1/video-generations/{id}` until ' +
    '`state` is `succeeded`, `failed`, `blocked` or `cancelled`; on success `output.url` is a signed download ' +
    'URL valid for 15 minutes (re-fetch the job for a fresh one). Credits for the requested duration are ' +
    'reserved up front and settled on completion; a failed, blocked or cancelled job is not charged. ' +
    'Send an `Idempotency-Key` header (1-255 printable ASCII characters) to make retries safe: a repeat with ' +
    'the same key and body returns the original job, and the same key with a different body is a 422 ' +
    '`idempotency_key_reused`. Omitted fields take the model defaults from `GET /api/v1/video-models`.',
  tags: ['Videos'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: CreateVideoGenerationBodySchema,
  requestExample: { model: 'gemini-omni-1.1-flash', prompt: 'A slow dolly shot of a red lighthouse at dusk' },
  responses: {
    202: {
      description: 'Accepted; the job is queued (or replayed for a repeated Idempotency-Key).',
      schema: VideoGenerationSchema,
      example: exampleJob,
    },
    403: scopeForbidden,
    404: {
      description: '`input_image_file_id` does not name an image you own (`errorCode: input_image_not_found`).',
      schema: VideoGenerationErrorResponseSchema,
    },
    422: {
      description:
        'The request cannot run: a body or capability violation (`errorCode` names it, e.g. ' +
        '`unsupported_duration`), an unknown or unavailable model (`model_unavailable`), a model your ' +
        'administrator disabled (`model_disabled`), too few credits (`insufficient_credits`), or an ' +
        'Idempotency-Key problem (`invalid_idempotency_key`, `idempotency_key_reused`).',
      schema: VideoGenerationErrorResponseSchema,
    },
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { model: 'gemini-omni-1.1-flash', prompt: 'A slow dolly shot of a red lighthouse at dusk' },
  },
});

export const getVideoGenerationContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/video-generations/{id}',
  operationId: 'getVideoGeneration',
  summary: 'Get a video generation',
  description:
    'Returns one job you requested. Each read signs a fresh `output.url` (valid 15 minutes, see `expires_at`).',
  tags: ['Videos'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  pathParams: VideoGenerationIdParamSchema,
  responses: {
    200: { description: 'The job.', schema: VideoGenerationSchema, example: exampleJob },
    403: scopeForbidden,
    404: notFound,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const listVideoGenerationsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/video-generations',
  operationId: 'listVideoGenerations',
  summary: 'List your video generations',
  description:
    'Your jobs, newest first, optionally filtered by `state` and `source`. Cursor-paginated (see the pagination ' +
    'convention): pass `next_cursor` back as `cursor` until it is `null`.',
  tags: ['Videos'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  queryParams: ListVideoGenerationsQuerySchema,
  responses: {
    200: { description: 'A page of jobs.', schema: ListVideoGenerationsResponseSchema },
    403: scopeForbidden,
    422: { description: 'A malformed `cursor`, `limit`, `state` or `source`.', schema: ApiErrorSchema },
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const cancelVideoGenerationContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/video-generations/{id}/cancel',
  operationId: 'cancelVideoGeneration',
  summary: 'Cancel a video generation',
  description:
    'Requests cancellation and returns the job. A `pending` or `running` job moves to `cancelled` shortly ' +
    'after and its reserved credits are returned. A job already `storing` or finished is returned unchanged ' +
    '(the provider has already produced, and charged for, the video).',
  tags: ['Videos'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  pathParams: VideoGenerationIdParamSchema,
  responses: {
    200: { description: 'The job after the cancel request.', schema: VideoGenerationSchema, example: exampleJob },
    403: scopeForbidden,
    404: notFound,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
