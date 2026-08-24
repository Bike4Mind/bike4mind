import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts
// (the barrel drags in @bike4mind/hearth, unbuilt in the CI openapi job).
import { musicRequestSchema } from '../../musicGeneration';
import { ApiErrorSchema, InsufficientCreditsErrorSchema } from '../../schemas/chat';
import { generatedAudioBody } from './audioResponses';

/**
 * Contract for POST /api/ai/music - background-music generation.
 *
 * The success body is raw audio bytes, so the 200 declares no schema - only the
 * media types the vendor can emit.
 */
export const generateMusicContract = defineEndpoint({
  method: 'post',
  path: '/api/ai/music',
  operationId: 'generateMusic',
  summary: 'Generate background music',
  description:
    'Generates an instrumental or vocal background-music track from a text prompt and returns the raw ' +
    'audio bytes. `lengthMs` (3000-120000, default 10000) is forced on the provider, so the generated ' +
    'track always matches the billed length; credits are reserved before generation and refunded if it ' +
    'fails. Generated audio is saved to the file browser by default (opt out via the saveGeneratedAudio ' +
    'preference); the outcome is reported via the `X-B4M-Audio-Saved` / `X-B4M-Audio-Fab-File-Id` / ' +
    '`X-B4M-Audio-File-Url` response headers - use `X-B4M-Audio-File-Url` to fetch the saved copy, since ' +
    '`GET /api/files/{id}` fails closed until moderation completes. Authenticate with an API key ' +
    '(`b4m_live_`) or a JWT.',
  tags: ['Audio'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: musicRequestSchema,
  requestExample: { prompt: 'calm lo-fi study beat with soft piano', lengthMs: 30000, forceInstrumental: true },
  responses: {
    200: {
      description: 'Raw audio bytes; the Content-Type follows the requested `format` (mp3 by default).',
      ...generatedAudioBody(),
    },
    400: { description: 'The billing user or organization could not be resolved.', schema: ApiErrorSchema },
    422: {
      description:
        'Request body failed validation, or the caller cannot afford the track - the latter is tagged ' +
        '`errorCode: "insufficient_credits"` (the balance is short, or the org member credit cap is exhausted).',
      schema: InsufficientCreditsErrorSchema,
    },
    502: {
      description: 'The provider failed to generate the track; reserved credits are refunded.',
      schema: ApiErrorSchema,
    },
    503: { description: 'No provider API key is configured for this deployment.', schema: ApiErrorSchema },
  },
  // Served by baseApi, so apiKeyRateLimit sets the windowed X-RateLimit-* headers.
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { prompt: 'calm lo-fi study beat with soft piano', lengthMs: 30000, forceInstrumental: true },
  },
});
