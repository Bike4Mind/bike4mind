import type { z } from 'zod';
import type { ResponseSpec } from '../types';
import { ELEVENLABS_AUDIO_CONTENT_TYPES } from '../../elevenLabsAudioFormat';

/**
 * Responses shared by the endpoints that return generated audio (TTS, music,
 * sound effects). Not a contract - the pieces all three declare, kept in one place
 * so the published shape cannot describe one endpoint and not another. The wire
 * model is generatedAudio.ts and the server half generatedAudioDelivery.ts; the
 * three must agree.
 */

/** Every Content-Type the music and sound-effects binary encodings can return (TTS declares its own). */
export const GENERATED_AUDIO_CONTENT_TYPES = ELEVENLABS_AUDIO_CONTENT_TYPES;

/**
 * Where the browsable copy of the generated audio ended up. The binary encoding
 * has no JSON body, so these are its only channel for that information.
 */
export const GENERATED_AUDIO_SAVE_HEADERS = {
  'X-B4M-Audio-Saved': 'Whether a browsable copy was saved to the file browser ("true"/"false").',
  'X-B4M-Audio-Fab-File-Id': 'Id of the saved file. Present only when the copy was saved.',
  'X-B4M-Audio-File-Name': 'File name of the saved copy. Present only when the copy was saved.',
  'X-B4M-Audio-File-Url':
    'Signed URL for the saved copy, minted at creation. Use this rather than re-resolving the file via ' +
    'GET /api/files/{id}, which fails closed until the async moderation scan completes.',
} as const;

/** Operation-description sentences shared by every generated-audio endpoint; appended to each one's own. */
export const GENERATED_AUDIO_DESCRIPTION =
  'The default `encoding: "binary"` returns the raw audio bytes; `encoding: "base64"` returns JSON. Audio ' +
  'over the ~4MB response ceiling is returned by signed URL (a `303` for binary, the `delivery: "url"` ' +
  'variant for base64). Generated audio is saved to the file browser unless the call sets `preview`; the ' +
  'outcome is reported in the JSON save fields and the `X-B4M-Audio-*` headers - fetch the saved copy ' +
  'from `fileUrl` / `X-B4M-Audio-File-Url`, ' +
  'since `GET /api/files/{id}` fails closed until moderation completes. Authenticate with an API key ' +
  '(`b4m_live_`) or a JWT.';

/**
 * The 200, 303 and 413 of a generated-audio endpoint. `json` is the endpoint's
 * `encoding: "base64"` body (built with extendGeneratedAudioResponseSchema),
 * `binaryContentTypes` the media types its default encoding can return, and
 * `headers` any endpoint-specific headers on top of the save headers.
 */
export function generatedAudioResponses(options: {
  description: string;
  json: { schema: z.ZodTypeAny; example: unknown };
  binaryContentTypes: readonly string[];
  headers?: Readonly<Record<string, string>>;
  tooLargeSchema: z.ZodTypeAny;
}): Record<200 | 303 | 413, ResponseSpec> {
  const headers = { ...GENERATED_AUDIO_SAVE_HEADERS, ...options.headers };
  return {
    200: {
      description:
        `${options.description} The default \`encoding: "binary"\` returns the raw audio bytes; ` +
        '`encoding: "base64"` returns the JSON body. Audio over the ~4MB response ceiling cannot ride in ' +
        'the body: the binary encoding answers `303` instead, and the base64 encoding returns the ' +
        '`delivery: "url"` variant, whose `url` is a time-limited signed GET for the audio (`bytes` is ' +
        'its size).',
      schema: options.json.schema,
      example: options.json.example,
      alsoReturns: options.binaryContentTypes.map(contentType => ({ contentType })),
      headers,
    },
    303: {
      description:
        'Binary encoding only: the audio exceeds the ~4MB response ceiling, so it was offloaded to storage and ' +
        '`Location` is a time-limited signed GET for it. HTTP clients that follow redirects receive the audio ' +
        'transparently (they drop the `Authorization` header on the cross-origin hop, as the signed URL ' +
        'requires); browser callers should use `encoding: "base64"`, since the storage origin sends no CORS ' +
        'headers. Carries the same `X-B4M-*` headers as the 200.',
      noBody: true,
      headers: { Location: 'Signed URL of the offloaded audio.', ...headers },
    },
    413: {
      description:
        'The audio was generated (and billed) and exceeds the response ceiling, and offloading it to ' +
        'storage failed. Retry, or request shorter output.',
      schema: options.tooLargeSchema,
    },
  };
}

/**
 * The 202 a generated-audio endpoint answers when the clip outlasts the request. `noun` names the clip, `schema` is
 * the endpoint's job resource. Speech and sound effects only: music has its own job API. Answered only for a clip
 * that is being saved to the file browser, the one place it can be picked up later (see unretrievableAudioResponse).
 */
export function outlastedAudioResponse(options: {
  noun: string;
  schema: z.ZodTypeAny;
  example: unknown;
}): ResponseSpec {
  return {
    description:
      `The ${options.noun} took longer than this request can wait (about 55 seconds), so no audio is returned. ` +
      'Generation carries on: the body is the job as it stands. When it finishes, the audio is saved to the ' +
      'file browser if your storage quota still has room for it. Credits are settled only if it succeeds and ' +
      'returned otherwise. This job cannot be polled through the API yet; look for the saved file instead of ' +
      'retrying, which would generate (and bill) a second clip.',
    schema: options.schema,
    example: options.example,
  };
}

/**
 * The 504 a speech or sound-effect endpoint answers when the clip outlasts the request and would not be saved to
 * the file browser (a `preview` call, or a storage quota with no room), so nothing could ever retrieve it.
 */
export function unretrievableAudioResponse(options: { noun: string; schema: z.ZodTypeAny }): ResponseSpec {
  return {
    description:
      `The ${options.noun} took longer than this request can wait, and it would not be saved to the file ` +
      'browser (a `preview` call, or a storage quota with no room for it), so it could never be retrieved. ' +
      'Tagged `errorCode: "request_timeout"`. The generation is cancelled and its credits returned, unless the ' +
      'provider had already started it: that one finishes and is billed. Retrying generates a new clip.',
    schema: options.schema,
  };
}
