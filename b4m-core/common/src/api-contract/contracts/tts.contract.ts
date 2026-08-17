import { defineEndpoint } from '../defineEndpoint';
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
 * Deliberately carries NO `scopes`: the route has always accepted any valid API
 * key, and adding a scope gate here would 403 keys that work today. Unlike the
 * music/sound-effects endpoints, which shipped scope-gated from the start.
 */
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
  request: ttsRequestSchema,
  requestExample: { text: 'Your password has been reset.', provider: 'openai', voice: 'alloy', format: 'mp3' },
  responses: {
    200: {
      description:
        'Speech synthesized. The default `encoding: "binary"` returns raw audio bytes whose ' +
        'Content-Type follows the requested `format` (`audio/mpeg` for mp3, else `audio/wav`, ' +
        '`audio/opus`, `audio/aac`, `audio/flac`, `audio/pcm`); `encoding: "base64"` returns the JSON body.',
      schema: ttsBase64ResponseSchema,
      example: {
        audio: 'SUQzBAAAAAAA...',
        format: 'mp3',
        contentType: 'audio/mpeg',
        saved: true,
        fabFileId: '664f1c2b9a1e4d0012ab34cd',
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
      // The binary encoding has no JSON body, so these headers are the only place
      // a caller can read the provider substitution and the saved-copy outcome.
      headers: {
        'X-B4M-Tts-Provider': 'The provider that produced the audio. Present only when a fallback happened.',
        'X-B4M-Tts-Provider-Fallback-From':
          'The originally requested provider that could not serve the request. Present only on a fallback.',
        'X-B4M-Audio-Saved': 'Whether a browsable copy was saved to the file browser ("true"/"false").',
        'X-B4M-Audio-Fab-File-Id': 'Id of the saved file. Present only when the copy was saved.',
      },
    },
    401: {
      description: 'Missing/invalid credentials, or no provider has a usable key (`provider_not_configured`).',
      schema: ttsErrorResponseSchema,
    },
    402: { description: 'Not enough credits to cover the synthesis.', schema: ttsErrorResponseSchema },
    413: {
      description:
        'The audio was generated (and billed) but is too large to return over this endpoint. Retrieve it ' +
        'from `fileUrl` when a browsable copy was saved.',
      schema: ttsResponseTooLargeSchema,
    },
    422: {
      description:
        'Request body failed validation, the text exceeds the provider character limit, or the provider ' +
        'cannot produce the requested `format`.',
      schema: ttsErrorResponseSchema,
    },
    429: { description: 'The provider rate-limited the request.', schema: ttsErrorResponseSchema },
    502: { description: 'The provider failed to generate speech.', schema: ttsErrorResponseSchema },
  },
  // Both exemptions are live-caller compatibility, not oversight: a 402 -> 422 move
  // and a newly required scope are the two kinds of change that cannot be aliased.
  // Removing either needs a published sunset. See CONVENTIONS.md.
  conventionExemptions: {
    'status-table': 'Insufficient credits is 402 here and 422 everywhere else; changing it breaks live callers.',
    'scope-required': 'The route has always accepted any valid API key; gating it now would 403 keys that work today.',
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { text: 'Your password has been reset.', provider: 'openai', voice: 'alloy', encoding: 'base64' },
  },
});
