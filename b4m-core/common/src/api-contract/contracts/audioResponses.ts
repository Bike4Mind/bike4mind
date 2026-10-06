import type { z } from 'zod';
import type { ResponseSpec } from '../types';

/**
 * Responses shared by the endpoints that return generated audio (TTS, music,
 * sound effects). Not a contract - the pieces all three declare, kept in one place
 * so the published shape cannot describe one endpoint and not another. The wire
 * model is generatedAudio.ts and the server half generatedAudioDelivery.ts; the
 * three must agree.
 */

/**
 * Every Content-Type the ElevenLabs generators map an `output_format` token to
 * (`contentTypeForFormat` in ElevenLabsMusicGenerator / ElevenLabsSoundGenerator).
 * Must stay in sync with those two mappings.
 */
export const GENERATED_AUDIO_CONTENT_TYPES = [
  'audio/mpeg',
  'audio/opus',
  'audio/L16',
  'audio/basic',
  'application/octet-stream',
] as const;

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
  'variant for base64). Generated audio is saved to the file browser by default (opt out per-user via the ' +
  'saveGeneratedAudio preference, or per-call with `preview`); the outcome is reported in the JSON save ' +
  'fields and the `X-B4M-Audio-*` headers - fetch the saved copy from `fileUrl` / `X-B4M-Audio-File-Url`, ' +
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
