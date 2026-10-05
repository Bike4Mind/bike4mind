import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import { EditImageRequestBodySchema } from '../../llm';
import { ApiErrorSchema } from '../../schemas/chat';
import { ImageQuestSchema } from '../../schemas/imageApi';
import { imageQuestPollResult } from './imageGeneration.contract';
import {
  GENERATION_CALLBACK_DESCRIPTION,
  GENERATION_CALLBACK_REJECTED_DESCRIPTION,
} from '../../schemas/generationCallback';

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
    'render runs. Poll `GET /api/v1/quests/{id}` until `status` is `"done"` (see the `editImage200PollResult` ' +
    'schema). `image` is the URL of the source image; `fabFileIds` must name at least one file, and the ' +
    'first is the inpainting mask. `referenceImageFabFileIds` adds up to 4 style anchors after the ' +
    'source image, so the mask always applies to the source; only gpt-image models accept them, and sending ' +
    'any with another model is rejected with a 400 rather than ignored. Both id fields take ids ' +
    'from `POST /api/v1/files`: upload each file, poll `GET /api/v1/files/{id}` until `moderation_status` ' +
    'is `clean`, then pass its `id`. An id that is not yet `clean` fails the edit on the polled quest. ' +
    '`image` takes a URL rather than an id, so a source uploaded the same way is passed as its ' +
    '`download_url`, which must still be unexpired when the render runs. The edited image is not a file ' +
    'id: read it from `files[].url` on the polled quest, not from `GET /api/v1/files/{id}`. ' +
    '`seed` makes an edit reproducible on BFL (FLUX) models only; gpt-image and Gemini models ignore it. ' +
    'Credits are checked when ' +
    'the render runs, so insufficient credits arrive on the polled quest rather than as a 422. ' +
    '`POST /api/ai/edit-image` is a legacy alias of this endpoint. Authenticate with an API key ' +
    '(`b4m_live_`) or a JWT.\n\n' +
    GENERATION_CALLBACK_DESCRIPTION,
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
        'outcome arrives on `GET /api/v1/quests/{id}`.',
      schema: ImageQuestSchema,
      pollResult: imageQuestPollResult,
    },
    400: {
      description:
        `\`fabFileIds\` is empty, \`referenceImageFabFileIds\` is set for a non-gpt-image model, or the ` +
        GENERATION_CALLBACK_REJECTED_DESCRIPTION,
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
    body: {
      prompt: 'replace the sky with a starry night',
      model: 'gpt-image-1',
      sessionId: '664f1c2b9a1e4d0012ab34aa',
      image: 'https://example.com/source.png',
      fabFileIds: ['664f1c2b9a1e4d0012ab34bb'],
    },
  },
});
