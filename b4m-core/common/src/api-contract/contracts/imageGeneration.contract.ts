import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts
// (the barrel drags in @bike4mind/hearth, unbuilt in the CI openapi job).
import { GenerateImageRequestBodySchema } from '../../llm';
import { ApiErrorSchema } from '../../schemas/chat';
import { GenerateImageResponseSchema, ImageQuestSchema } from '../../schemas/imageApi';
import {
  GENERATION_CALLBACK_DESCRIPTION,
  GENERATION_CALLBACK_REJECTED_DESCRIPTION,
} from '../../schemas/generationCallback';

/** Shared by generateImage and editImage: both hand off to the same quest poll. */
export const imageQuestPollResult = {
  schema: ImageQuestSchema,
  description:
    'The quest polled at `GET /api/v1/quests/{id}` after this ACK. The render is finished once `status` is ' +
    '`"done"`: on success `images` holds the rendered images; a render that FAILED is `type: "error"` with ' +
    'the reason in `reply`, never a 4xx. That covers credit exhaustion (tagged `errorCode: ' +
    '"insufficient_credits"`, the same vocabulary as the synchronous 422s on the audio endpoints), a ' +
    'provider error, and a reference image that is missing, not an image, or still in moderation. Check ' +
    '`type` before reading `images`; `errorCode` is absent on unclassified failures, so its absence does ' +
    'not mean success.',
  example: {
    id: '664f1c2b9a1e4d0012ab34cd',
    sessionId: '664f1c2b9a1e4d0012ab34aa',
    status: 'done',
    type: 'message',
    images: ['3f6c1a52-9d1e-4b7a-8c2f-5e0d4a9b1c7e.png'],
  },
} as const;

/**
 * Contract for POST /api/v1/image-generations. `/api/ai/generate-image` serves the
 * same handler as a legacy alias (it predates the /api/v1 root and cannot move -
 * CONVENTIONS.md section 3), so only this path is published.
 */
export const generateImageContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/image-generations',
  operationId: 'generateImage',
  summary: 'Generate an image',
  description:
    'Queues an image generation and returns immediately with the quest that will carry the result - no ' +
    'image yet, and the call never blocks on the render. Poll `GET /api/v1/quests/{id}` until `status` is ' +
    '`"done"` (see the `generateImage200PollResult` schema). Omit `sessionId` to create a new session. ' +
    'The prompt is resolved against the session history first, so a follow-up such as "make it darker" ' +
    'binds to the previous image; `enhancedPrompt` reports the prompt actually sent to the model. Send ' +
    '`promptResolution: "literal"` to skip that step and have the prompt sent as written (apart ' +
    "from truncation to the model's prompt limit). " +
    '`referenceImageFabFileIds` passes up to 4 already-uploaded images as style anchors, after the input ' +
    'image taken from `fabFileIds`. Only gpt-image models accept them: sending any with another model is ' +
    'rejected with a 400 rather than ignored. Credits are checked when the render runs, so ' +
    'insufficient credits arrive on the polled quest rather than as a 422. `POST /api/ai/generate-image` ' +
    'is a legacy alias of this endpoint. Authenticate with an API key (`b4m_live_`) or a JWT.\n\n' +
    GENERATION_CALLBACK_DESCRIPTION,
  tags: ['Images'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: GenerateImageRequestBodySchema,
  requestExample: { prompt: 'a watercolor lighthouse at dusk', model: 'gpt-image-1', size: '1024x1024' },
  responses: {
    200: {
      description:
        'Generation queued - NOT a finished render. `quest` has no images yet; its outcome arrives on ' +
        '`GET /api/v1/quests/{id}`.',
      schema: GenerateImageResponseSchema,
      pollResult: imageQuestPollResult,
    },
    400: {
      description: `\`referenceImageFabFileIds\` is set for a non-gpt-image model, or the ${GENERATION_CALLBACK_REJECTED_DESCRIPTION}`,
      schema: ApiErrorSchema,
    },
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
    body: { prompt: 'a watercolor lighthouse at dusk', model: 'gpt-image-1', size: '1024x1024' },
  },
});
