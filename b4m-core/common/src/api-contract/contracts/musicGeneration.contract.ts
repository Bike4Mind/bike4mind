import { defineEndpoint } from '../defineEndpoint';
import { EXAMPLE_RESOURCE_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';
import {
  CreateMusicGenerationBodySchema,
  ListMusicGenerationsQuerySchema,
  ListMusicGenerationsResponseSchema,
  ListMusicModelsResponseSchema,
  MusicGenerationErrorResponseSchema,
  MusicGenerationIdParamSchema,
  MusicGenerationSchema,
} from '../../schemas/musicGenerations';

// The async job resource. The legacy synchronous POST /api/ai/music lives in music.contract.ts.

const examplePrompt = 'An upbeat synth-pop song about a road trip at sunrise';

const exampleJob = {
  id: EXAMPLE_RESOURCE_ID,
  object: 'music_generation',
  state: 'pending',
  model: 'lyria-3.5',
  prompt: examplePrompt,
  lyrics: null,
  instrumental: false,
  duration_seconds: 120,
  source: 'api',
  error: null,
  output: null,
  credits: { reserved: 80, settled: null },
  created_at: '2026-10-14T00:00:00.000Z',
  updated_at: '2026-10-14T00:00:00.000Z',
} as const;

const scopeForbidden = { description: 'The API key lacks the `ai:generate` scope.', schema: ScopeForbiddenErrorSchema };
const notFound = {
  description: 'No music generation with that id was requested by the caller (a malformed id is also a 404).',
  schema: ApiErrorSchema,
};
const rateLimited = { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema };

export const listMusicModelsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/music-models',
  operationId: 'listMusicModels',
  summary: 'List the music models you can use',
  description:
    'Returns the music models that are enabled, available in this deployment and have a usable provider key ' +
    'for the caller, with their capabilities and credit price. Validate requests against these capabilities: ' +
    'an unsupported duration, lyrics or vocals option is a 422, never silently adjusted.',
  tags: ['Music'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  responses: {
    200: { description: 'The usable models.', schema: ListMusicModelsResponseSchema },
    403: scopeForbidden,
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const createMusicGenerationContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/music-generations',
  operationId: 'createMusicGeneration',
  summary: 'Start a music generation',
  description:
    'Queues a song and returns `202` with the job. Poll `GET /api/v1/music-generations/{id}` until `state` is ' +
    '`succeeded`, `failed`, `blocked` or `cancelled`. A finished song is saved to your Files with the ' +
    '`generated` tag. On success, `output.availability` says whether it can be downloaded: `ready` means ' +
    '`output.url` is a signed download URL valid for 15 minutes (re-fetch the job for a fresh one); ' +
    '`pending_scan` means the saved file is still being scanned, so keep re-fetching the job (self-hosted ' +
    'installs can stay here for up to ~30 minutes); `unavailable` means the file was blocked or deleted and ' +
    '`output.url` will never be set, so stop polling. ' +
    "Credits for the model's price are reserved up front and settled on completion; a failed or cancelled job " +
    'is not charged. A `blocked` job is not charged either, unless the provider generated the song before ' +
    'rejecting it and billed it: then the price is charged and `credits.settled` shows it. ' +
    'Send an `Idempotency-Key` header (1-255 printable ASCII characters) to make retries safe: a repeat with ' +
    'the same key and body returns the original job, and the same key with a different body is a 422 ' +
    '`idempotency_key_reused`. Omitted fields take the model defaults from `GET /api/v1/music-models`. ' +
    'Set `organization_id` to bill an organization you belong to, or `null` to bill your personal credits; ' +
    'omitted, the job bills your home organization (or your personal credits if you have none). Keys are ' +
    'scoped to the billed account, so the same key sent for a different `organization_id` starts a new job.',
  tags: ['Music'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: CreateMusicGenerationBodySchema,
  requestExample: { model: 'lyria-3.5', prompt: examplePrompt },
  responses: {
    202: {
      description: 'Accepted; the job is queued (or replayed for a repeated Idempotency-Key).',
      schema: MusicGenerationSchema,
      example: exampleJob,
    },
    403: {
      description:
        'The API key lacks the `ai:generate` scope, or `organization_id` names an organization you do not ' +
        'belong to (or is not a valid id).',
      schema: ScopeForbiddenErrorSchema,
    },
    404: {
      description: 'A nonexistent `organization_id`, for an admin caller; for anyone else it is `403`.',
      schema: ApiErrorSchema,
    },
    422: {
      description:
        'The request cannot run: a body or capability violation (`errorCode` names it, e.g. ' +
        '`unsupported_duration` or `lyrics_too_long`), an unknown or unavailable model (`model_unavailable`), a ' +
        'model your administrator disabled (`model_disabled`), too few credits (`insufficient_credits`), no room ' +
        'in your Files storage for the song (`storage_limit_exceeded`), or an Idempotency-Key problem ' +
        '(`invalid_idempotency_key`, `idempotency_key_reused`).',
      schema: MusicGenerationErrorResponseSchema,
    },
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { model: 'lyria-3.5', prompt: examplePrompt },
  },
});

export const getMusicGenerationContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/music-generations/{id}',
  operationId: 'getMusicGeneration',
  summary: 'Get a music generation',
  description:
    'Returns one job you requested. Each read signs a fresh `output.url` (valid 15 minutes, see `expires_at`).',
  tags: ['Music'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  pathParams: MusicGenerationIdParamSchema,
  responses: {
    200: { description: 'The job.', schema: MusicGenerationSchema, example: exampleJob },
    403: scopeForbidden,
    404: notFound,
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const listMusicGenerationsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/music-generations',
  operationId: 'listMusicGenerations',
  summary: 'List your music generations',
  description:
    'Your jobs, newest first, optionally filtered by `state` and `source`. Cursor-paginated (see the pagination ' +
    'convention): pass `next_cursor` back as `cursor` until it is `null`.',
  tags: ['Music'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  queryParams: ListMusicGenerationsQuerySchema,
  responses: {
    200: { description: 'A page of jobs.', schema: ListMusicGenerationsResponseSchema },
    403: scopeForbidden,
    422: { description: 'A malformed `cursor`, `limit`, `state` or `source`.', schema: ApiErrorSchema },
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const cancelMusicGenerationContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/music-generations/{id}/cancel',
  operationId: 'cancelMusicGeneration',
  summary: 'Cancel a music generation',
  description:
    'Requests cancellation and returns the job. A job still waiting to start (or to retry) moves to `cancelled` ' +
    'shortly after and its reserved credits are returned. The provider renders a song in one call that cannot ' +
    'be interrupted, so a cancel that arrives while the song is rendering does not stop it: the job finishes ' +
    'and is charged. A finished job is returned unchanged.',
  tags: ['Music'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  pathParams: MusicGenerationIdParamSchema,
  responses: {
    200: { description: 'The job after the cancel request.', schema: MusicGenerationSchema, example: exampleJob },
    403: scopeForbidden,
    404: notFound,
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
