import { defineEndpoint } from '../defineEndpoint';
import { EXAMPLE_RESOURCE_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
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
// The binary encoding has no JSON body, so these headers are the only place a
// caller can read the provider substitution and the saved-copy outcome.
const TTS_AUDIO_HEADERS = {
  'X-B4M-Tts-Provider': 'The provider that produced the audio. Present only when a fallback happened.',
  'X-B4M-Tts-Provider-Fallback-From':
    'The originally requested provider that could not serve the request. Present only on a fallback.',
  'X-B4M-Audio-Saved': 'Whether a browsable copy was saved to the file browser ("true"/"false").',
  'X-B4M-Audio-Fab-File-Id': 'Id of the saved file. Present only when the copy was saved.',
} as const;

export const synthesizeSpeechContract = defineEndpoint({
  method: 'post',
  path: '/api/ai/tts',
  operationId: 'synthesizeSpeech',
  summary: 'Synthesize speech from text',
  description:
    'Generates speech from text using OpenAI or ElevenLabs. The default `encoding: "binary"` streams ' +
    'raw audio bytes with an `audio/*` Content-Type; `encoding: "base64"` returns JSON instead. When ' +
    'the requested provider has no usable key (or the provider rejects it), another configured ' +
    'provider stands in and the substitution is reported via `provider`/`fallbackFrom` and the ' +
    '`X-B4M-Tts-Provider*` headers. Input length is capped per provider (OpenAI 4096 characters, ' +
    'ElevenLabs 10000), and an output `format` the chosen provider cannot produce is rejected with a ' +
    '422 before any provider cost is incurred. Generated audio is saved to the file browser by ' +
    'default (opt out per-user via the saveGeneratedAudio preference, or per-call with `preview`); ' +
    'the outcome is reported via `saved`/`fabFileId` and the `X-B4M-Audio-*` headers. ' +
    'Authenticate with an API key (`b4m_live_`) or a JWT.',
  tags: ['Audio'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: ttsRequestSchema,
  requestExample: { text: 'Your password has been reset.', provider: 'openai', voice: 'alloy', format: 'mp3' },
  responses: {
    200: {
      description:
        'Speech synthesized. The default `encoding: "binary"` returns raw audio bytes whose ' +
        'Content-Type follows the requested `format` (`audio/mpeg` for mp3, else `audio/wav`, ' +
        '`audio/opus`, `audio/aac`, `audio/flac`, `audio/pcm`); `encoding: "base64"` returns the JSON body. ' +
        'Audio over the ~4MB response ceiling cannot ride in the body: the binary encoding answers with a ' +
        '`303` instead, and the base64 encoding with the `delivery: "url"` variant, whose `url` is a ' +
        'time-limited signed GET for the audio (`bytes` is its size).',
      schema: ttsBase64ResponseSchema,
      example: {
        delivery: 'inline',
        audio: 'SUQzBAAAAAAA...',
        format: 'mp3',
        contentType: 'audio/mpeg',
        saved: true,
        fabFileId: EXAMPLE_RESOURCE_ID,
      },
      // Raw-byte bodies for the default encoding. One entry per Content-Type the
      // vendor services can emit, so a generated SDK does not type 200 as JSON only.
      alsoReturns: [
        { contentType: 'audio/mpeg' },
        { contentType: 'audio/wav' },
        { contentType: 'audio/opus' },
        { contentType: 'audio/aac' },
        { contentType: 'audio/flac' },
        { contentType: 'audio/pcm' },
      ],
      headers: TTS_AUDIO_HEADERS,
    },
    303: {
      description:
        'Binary encoding only: the audio exceeds the ~4MB response ceiling, so it was offloaded to storage and ' +
        '`Location` is a time-limited signed GET for it. HTTP clients that follow redirects receive the audio ' +
        'transparently (they drop the `Authorization` header on the cross-origin hop, as the signed URL ' +
        'requires). Carries the same `X-B4M-*` headers as the 200.',
      noBody: true,
      headers: {
        Location: 'Signed URL of the offloaded audio.',
        ...TTS_AUDIO_HEADERS,
      },
    },
    401: {
      description:
        'Missing/invalid credentials, no provider has a usable key (`provider_not_configured`), or the ' +
        'provider refused the key we sent and no alternate could stand in (`provider_rejected`).',
      schema: ttsErrorResponseSchema,
    },
    413: {
      description:
        'The audio was generated (and billed) and exceeds the response ceiling, and offloading it to ' +
        'storage failed. Retry, or request shorter text.',
      schema: ttsResponseTooLargeSchema,
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
