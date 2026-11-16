import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';
import { ListImageModelsResponseSchema } from '../../schemas/imageModels';

export const listImageModelsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/image-models',
  operationId: 'listImageModels',
  summary: 'List the image models you can use',
  description:
    'Returns the image models that are offered to the caller, served by this deployment and backed by a usable ' +
    'provider key, best first, with their capabilities per mode and an indicative credit price. The capabilities ' +
    'and prices are those of image jobs, which refuse an unsupported size, aspect ratio, quality or input image ' +
    'rather than adjust it. `POST /api/v1/image-generations` and `POST /api/v1/image-edits` do not run as image ' +
    'jobs yet and may adapt a request to the model, for example by rendering a transparent background on a model ' +
    'that supports it.',
  tags: ['Images'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  responses: {
    200: { description: 'The usable models, best first.', schema: ListImageModelsResponseSchema },
    403: { description: 'The API key lacks the `ai:generate` scope.', schema: ScopeForbiddenErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
