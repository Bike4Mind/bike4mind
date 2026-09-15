import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts
// (the barrel drags in @bike4mind/hearth, unbuilt in the CI openapi job).
import { soundEffectsRequestSchema } from '../../soundGeneration';
import { ApiErrorSchema, InsufficientCreditsErrorSchema } from '../../schemas/chat';
import { generatedAudioBody } from './audioResponses';

/**
 * Contract for POST /api/ai/sound-effects - one-shot sound-effect generation.
 *
 * The success body is raw audio bytes, so the 200 declares no schema - only the
 * media types the vendor can emit. Mirrors music.contract.ts.
 */
export const generateSoundEffectContract = defineEndpoint({
  method: 'post',
  path: '/api/ai/sound-effects',
  operationId: 'generateSoundEffect',
  summary: 'Generate a sound effect',
  description:
    'Generates a short sound effect from a text description and returns the raw audio bytes. ' +
    'Omitting `durationSeconds` lets the provider pick the length (and bills at its default); ' +
    '`promptInfluence` trades prompt fidelity (1) against variation (0). Credits are reserved before ' +
    'generation and refunded if it fails. Generated audio is saved to the file browser by default (opt ' +
    'out via the saveGeneratedAudio preference); the outcome is reported via the `X-B4M-Audio-Saved` / ' +
    '`X-B4M-Audio-Fab-File-Id` / `X-B4M-Audio-File-Url` response headers - use `X-B4M-Audio-File-Url` to ' +
    'fetch the saved copy, since `GET /api/files/{id}` fails closed until moderation completes. ' +
    'Authenticate with an API key (`b4m_live_`) or a JWT.',
  tags: ['Audio'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: soundEffectsRequestSchema,
  requestExample: { text: 'heavy wooden door creaking open', durationSeconds: 3, promptInfluence: 0.5 },
  responses: {
    200: {
      description: 'Raw audio bytes; the Content-Type follows the requested `format` (mp3 by default).',
      ...generatedAudioBody(),
    },
    400: { description: 'The billing user or organization could not be resolved.', schema: ApiErrorSchema },
    422: {
      description:
        'Request body failed validation, or the caller cannot afford the effect - the latter is tagged ' +
        '`errorCode: "insufficient_credits"` (the balance is short, or the org member credit cap is exhausted).',
      schema: InsufficientCreditsErrorSchema,
    },
    502: {
      description: 'The provider failed to generate the effect; reserved credits are refunded.',
      schema: ApiErrorSchema,
    },
    503: { description: 'No provider API key is configured for this deployment.', schema: ApiErrorSchema },
  },
  // Served by baseApi, so apiKeyRateLimit sets the windowed X-RateLimit-* headers.
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { text: 'heavy wooden door creaking open', durationSeconds: 3, promptInfluence: 0.5 },
  },
});
