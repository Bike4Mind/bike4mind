import { defineEndpoint } from '../defineEndpoint';
import { EXAMPLE_RESOURCE_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { GENERATED_AUDIO_DESCRIPTION, generatedAudioResponses } from './audioResponses';
// Import the specific schema files, NOT the barrel (`../../schemas`) - see the
// note in tools.contract.ts (the barrel drags in an unbuilt dist in the CI
// openapi job).
import {
  ttsRequestSchema,
  ttsBase64ResponseSchema,
  ttsErrorResponseSchema,
  ttsResponseTooLargeSchema,
} from '../../voiceGeneration';

/**
 * Contract for POST /api/ai/tts - multi-provider text-to-speech.
 *
 * Gated on `ai:generate`, matching /api/ai/music and /api/ai/sound-effects: all
 * three are credit-metered audio generation, so all three take the same scope.
 */
export const synthesizeSpeechContract = defineEndpoint({
  method: 'post',
  path: '/api/ai/tts',
  operationId: 'synthesizeSpeech',
  summary: 'Synthesize speech from text',
  description:
    'Generates speech from text using OpenAI or ElevenLabs. When the requested provider has no usable key (or the provider rejects it), another configured ' +
    'provider stands in and the substitution is reported via `provider`/`fallbackFrom` and the ' +
    '`X-B4M-Tts-Provider*` headers. Input length is capped per provider (OpenAI 4096 characters, ' +
    'ElevenLabs 10000), and an output `format` the chosen provider cannot produce is rejected with a ' +
    '422 before any provider cost is incurred. ' +
    GENERATED_AUDIO_DESCRIPTION,
  tags: ['Audio'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: ttsRequestSchema,
  requestExample: { text: 'Your password has been reset.', provider: 'openai', voice: 'alloy', format: 'mp3' },
  responses: {
    ...generatedAudioResponses({
      description:
        'Speech synthesized. Binary bodies carry a Content-Type that follows the requested `format` ' +
        '(`audio/mpeg` for mp3, else `audio/wav`, `audio/opus`, `audio/aac`, `audio/flac`, `audio/pcm`).',
      json: {
        schema: ttsBase64ResponseSchema,
        example: {
          delivery: 'inline',
          audio: 'SUQzBAAAAAAA...',
          format: 'mp3',
          contentType: 'audio/mpeg',
          saved: true,
          fabFileId: EXAMPLE_RESOURCE_ID,
        },
      },
      binaryContentTypes: ['audio/mpeg', 'audio/wav', 'audio/opus', 'audio/aac', 'audio/flac', 'audio/pcm'],
      headers: {
        'X-B4M-Tts-Provider': 'The provider that produced the audio. Present only when a fallback happened.',
        'X-B4M-Tts-Provider-Fallback-From':
          'The originally requested provider that could not serve the request. Present only on a fallback.',
      },
      tooLargeSchema: ttsResponseTooLargeSchema,
    }),
    401: {
      description:
        'Missing/invalid credentials, no provider has a usable key (`provider_not_configured`), or the ' +
        'provider refused the key we sent and no alternate could stand in (`provider_rejected`).',
      schema: ttsErrorResponseSchema,
    },
    422: {
      description:
        'Request body failed validation, the text exceeds the provider character limit, the provider ' +
        'cannot produce the requested `format`, the provider rejected the request (e.g. an unknown voice), ' +
        'or the caller cannot afford the synthesis - the last of ' +
        'those is the only one tagged `errorCode: "insufficient_credits"`, so match on the classifier ' +
        'rather than the status to tell a billing failure from a bad request.',
      schema: ttsErrorResponseSchema,
    },
    429: { description: 'The provider rate-limited the request.', schema: ttsErrorResponseSchema },
    502: { description: 'The provider failed to generate speech.', schema: ttsErrorResponseSchema },
  },
  // Served by baseApi, so apiKeyRateLimit sets the windowed X-RateLimit-* headers.
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { text: 'Your password has been reset.', provider: 'openai', voice: 'alloy', encoding: 'base64' },
  },
});
