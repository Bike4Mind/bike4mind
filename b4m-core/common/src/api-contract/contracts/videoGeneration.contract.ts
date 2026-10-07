import { defineEndpoint } from '../defineEndpoint';
import { EXAMPLE_RESOURCE_ID, EXAMPLE_SESSION_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import { GenerateVideoRequestBodySchema } from '../../schemas/sora';
import { ApiErrorSchema } from '../../schemas/chat';
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
