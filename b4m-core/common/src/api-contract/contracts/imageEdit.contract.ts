import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import { EditImageRequestBodySchema } from '../../llm';
import { ApiErrorSchema } from '../../schemas/chat';
import { ImageQuestSchema } from '../../schemas/imageApi';
import { imageQuestPollResult } from './imageGeneration.contract';

/**
 * Contract for POST /api/v1/image-edits. `/api/ai/edit-image` serves the same
 * handler as a legacy alias, like generateImage's.
 */
export const editImageContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/image-edits',
  operationId: 'editImage',
  summary: 'Edit an image',
  description:
    'Queues an edit of an existing image and returns the quest that will carry the result, before the ' +
    'render runs. Poll `GET /api/quests/{id}` until `status` is `"done"` (see the `editImage200PollResult` ' +
    'schema). `image` is the URL of the source image; `fabFileIds` must name at least one file, and the ' +
    'first is the inpainting mask. `referenceImageFabFileIds` (gpt-image models only) adds up to 4 style ' +
    'anchors after the source image, so the mask always applies to the source. Credits are checked when ' +
    'the render runs, so insufficient credits arrive on the polled quest rather than as a 422. ' +
    '`POST /api/ai/edit-image` is a legacy alias of this endpoint. Authenticate with an API key ' +
    '(`b4m_live_`) or a JWT.',
  tags: ['Images'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: EditImageRequestBodySchema,
  requestExample: {
    prompt: 'replace the sky with a starry night',
    model: 'gpt-image-1',
    sessionId: '664f1c2b9a1e4d0012ab34aa',
    image: 'https://example.com/source.png',
    fabFileIds: ['664f1c2b9a1e4d0012ab34bb'],
  },
  responses: {
    200: {
      description:
        'Edit queued - NOT a finished render. The body is the quest itself, with no images yet; its ' +
        'outcome arrives on `GET /api/quests/{id}`.',
      schema: ImageQuestSchema,
      pollResult: imageQuestPollResult,
    },
    400: {
      description: '`fabFileIds` is empty, or `organizationId` is not a valid organization id.',
      schema: ApiErrorSchema,
    },
    404: {
      description:
        'The session, the quest being retried, or the billing organization does not exist or is not ' +
        'accessible to the caller.',
      schema: ApiErrorSchema,
    },
  },
  // Served by baseApi, so apiKeyRateLimit sets the windowed X-RateLimit-* headers.
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: {
      prompt: 'replace the sky with a starry night',
      model: 'gpt-image-1',
      sessionId: '664f1c2b9a1e4d0012ab34aa',
      image: 'https://example.com/source.png',
      fabFileIds: ['664f1c2b9a1e4d0012ab34bb'],
    },
  },
});
