import { defineEndpoint } from '../defineEndpoint';
import { EXAMPLE_FILE_ID, EXAMPLE_RESOURCE_ID, EXAMPLE_SECOND_FILE_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import { ApiErrorSchema, ScopeForbiddenErrorSchema, StorageLimitErrorSchema } from '../../schemas/chat';
import {
  CreateSceneCompositionBodySchema,
  ListSceneCompositionsQuerySchema,
  ListSceneCompositionsResponseSchema,
  SCENE_COMPOSITION_LIMITS_DESCRIPTION,
  SceneCompositionErrorResponseSchema,
  SceneCompositionIdParamSchema,
  SceneCompositionSchema,
} from '../../schemas/sceneCompositions';

// The async job resource that renders a Scene: a video and a music track muxed into one clip.

const exampleVideoFileId = EXAMPLE_FILE_ID;
const exampleAudioFileId = EXAMPLE_SECOND_FILE_ID;

const exampleJob = {
  id: EXAMPLE_RESOURCE_ID,
  object: 'scene_composition',
  state: 'pending',
  video_file_id: exampleVideoFileId,
  audio_file_id: exampleAudioFileId,
  cover_file_id: null,
  title: null,
  audio: { fit: 'trim', fade_in_seconds: 0, fade_out_seconds: 1.5 },
  source: 'api',
  error: null,
  output: null,
  credits: { reserved: null, settled: null },
  created_at: '2026-11-17T00:00:00.000Z',
  updated_at: '2026-11-17T00:00:00.000Z',
} as const;

const exampleBody = { video_file_id: exampleVideoFileId, audio_file_id: exampleAudioFileId };

const scopeForbidden = { description: 'The API key lacks the `ai:generate` scope.', schema: ScopeForbiddenErrorSchema };
const notFound = {
  description: 'No scene composition with that id was requested by the caller (a malformed id is also a 404).',
  schema: ApiErrorSchema,
};
const rateLimited = { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema };

export const createSceneCompositionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/scene-compositions',
  operationId: 'createSceneComposition',
  summary: 'Compose a Scene from a video and a music track',
  description:
    'Queues a Scene: one shareable clip made from a video file and an audio file you own, with optional cover ' +
    'art, and returns `202` with the job. The Scene runs exactly as long as the video: its picture is copied ' +
    'unchanged and the audio is trimmed (or looped) to fit, with optional fades. ' +
    `${SCENE_COMPOSITION_LIMITS_DESCRIPTION} ` +
    'Poll `GET /api/v1/scene-compositions/{id}` until `state` is `succeeded`, `failed` or `cancelled`. The ' +
    'finished Scene is saved to your Files with the `generated` and `scene` tags, linked to its inputs (see ' +
    '`GET /api/v1/files/{id}/lineage`); if that save fails it is kept outside Files and `output.file_id` is ' +
    'null. `output.availability` works as on the other generation jobs: `ready` means `output.url` is a signed ' +
    'download URL valid for 15 minutes (re-fetch the job for a fresh one), `pending_scan` means keep ' +
    're-fetching, and `unavailable` means stop polling. ' +
    'A file that cannot be read as the media its slot needs (no video stream, an over-long video) ends the job ' +
    '`failed` with `unsupported_input`. Composing is free: no credits are reserved or charged. ' +
    'Send an `Idempotency-Key` header (1-255 printable ASCII characters) to make retries safe: a repeat with ' +
    'the same key and body returns the original job, and the same key with a different body is a 422 ' +
    '`idempotency_key_reused`.',
  tags: ['Scenes'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: CreateSceneCompositionBodySchema,
  requestExample: exampleBody,
  responses: {
    202: {
      description: 'Accepted; the job is queued (or replayed for a repeated Idempotency-Key).',
      schema: SceneCompositionSchema,
      example: exampleJob,
    },
    400: {
      description:
        'Your Files storage has no room for the Scene (`storage_limit_exceeded`, as on the Files upload routes). ' +
        'The body carries `used_bytes`, `limit_bytes`, `requested_bytes` and `owner`, always together; ' +
        '`requested_bytes` is the most the Scene can take (the size of its inputs), not its final size.',
      schema: StorageLimitErrorSchema,
    },
    403: scopeForbidden,
    404: {
      description:
        'An input file id is not one of your files, is deleted, or is still being scanned ' +
        '(`errorCode: input_file_not_found`). An API key without `files:read` may only name generated files ' +
        'and images staged by an `ai:generate` key without `files:write`; any other file is reported the ' +
        'same way.',
      schema: SceneCompositionErrorResponseSchema,
    },
    422: {
      description:
        'The request cannot run: a malformed body (`invalid_request`), a file of the wrong kind for its slot ' +
        '(`unsupported_input`), inputs over the size limit (`limit_exceeded`), or an Idempotency-Key problem ' +
        '(`invalid_idempotency_key`, `idempotency_key_reused`).',
      schema: SceneCompositionErrorResponseSchema,
    },
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: exampleBody },
});

export const getSceneCompositionContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/scene-compositions/{id}',
  operationId: 'getSceneComposition',
  summary: 'Get a scene composition',
  description:
    'Returns one job you requested. Each read signs a fresh `output.url` (valid 15 minutes, see `expires_at`).',
  tags: ['Scenes'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  pathParams: SceneCompositionIdParamSchema,
  responses: {
    200: { description: 'The job.', schema: SceneCompositionSchema, example: exampleJob },
    403: scopeForbidden,
    404: notFound,
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const listSceneCompositionsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/scene-compositions',
  operationId: 'listSceneCompositions',
  summary: 'List your scene compositions',
  description:
    'Your jobs, newest first, optionally filtered by `state` and `source`. Cursor-paginated (see the pagination ' +
    'convention): pass `next_cursor` back as `cursor` until it is `null`.',
  tags: ['Scenes'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  queryParams: ListSceneCompositionsQuerySchema,
  responses: {
    200: { description: 'A page of jobs.', schema: ListSceneCompositionsResponseSchema },
    403: scopeForbidden,
    422: { description: 'A malformed `cursor`, `limit`, `state` or `source`.', schema: ApiErrorSchema },
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const cancelSceneCompositionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/scene-compositions/{id}/cancel',
  operationId: 'cancelSceneComposition',
  summary: 'Cancel a scene composition',
  description:
    'Requests cancellation and returns the job. A job still `pending` (waiting to start, or to retry) moves to ' +
    '`cancelled` shortly after. A Scene renders in one uninterruptible step, so a `running` job cannot be ' +
    'cancelled: the request is refused with a 409 (`not_cancellable`) and the job runs to its end. A finished ' +
    'job is returned unchanged.',
  tags: ['Scenes'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  pathParams: SceneCompositionIdParamSchema,
  responses: {
    200: { description: 'The job after the cancel request.', schema: SceneCompositionSchema, example: exampleJob },
    403: scopeForbidden,
    404: notFound,
    409: {
      description: 'The Scene is already rendering (`running`); `errorCode` is `not_cancellable`.',
      schema: SceneCompositionErrorResponseSchema,
    },
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
