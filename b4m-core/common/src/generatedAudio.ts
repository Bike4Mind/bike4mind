import z from 'zod';

/**
 * Wire model shared by every endpoint that returns generated audio (TTS, music,
 * sound effects). The server half is apps/client/server/utils/generatedAudioDelivery.ts
 * and the published contract half is api-contract/contracts/audioResponses.ts; the
 * three must describe the same responses.
 */

/**
 * How the caller wants the audio back. 'binary' (the default) returns raw bytes
 * with an audio/* Content-Type, or a 303 to a signed URL when the audio is too
 * large to inline; 'base64' returns the JSON body built by
 * `generatedAudioResponseSchema`. Browser callers should use 'base64': following
 * the 303 cross-origin needs CORS on the storage bucket.
 */
export const generatedAudioEncodingSchema = z.enum(['binary', 'base64']);

export type GeneratedAudioEncoding = z.infer<typeof generatedAudioEncodingSchema>;

/** Request fields every generated-audio endpoint accepts; spread into each request schema. */
export const generatedAudioRequestFields = {
  encoding: generatedAudioEncodingSchema.optional(),
  /**
   * When true, the result is throwaway (e.g. the Settings voice audition) and is
   * never saved to the file browser, regardless of the saveGeneratedAudio preference.
   */
  preview: z.boolean().optional(),
};

/**
 * Why a browsable copy of generated audio was not kept. Saving is best-effort and
 * never fatal (the caller was already billed for the bytes it is being handed), so
 * this is reported alongside a successful response rather than as an error.
 */
export const audioSaveSkippedReasonSchema = z.enum(['storage_limit', 'file_too_large', 'error']);

export type AudioSaveSkippedReason = z.infer<typeof audioSaveSkippedReasonSchema>;

/**
 * Whether generated audio gets a browsable copy in the user's files. The one gate
 * for every producer - the HTTP routes and the LLM chat tools - so an opt-out
 * holds everywhere. `preview` is a per-call opt-out for throwaway audio.
 */
export function shouldPersistGeneratedAudio(params: {
  userId: string | undefined;
  saveGeneratedAudio: boolean | undefined;
  preview?: boolean;
}): boolean {
  return Boolean(params.userId) && !params.preview && (params.saveGeneratedAudio ?? true);
}

/**
 * Where the browsable copy ended up. All optional because they are present only
 * when a save was attempted (`saved`), succeeded (`fabFileId`/`fileName`/
 * `fileUrl`) or was skipped (`saveSkippedReason`).
 */
const generatedAudioSaveFields = {
  saved: z.boolean().optional(),
  fabFileId: z.string().optional(),
  fileName: z.string().optional(),
  /** Signed URL minted at creation; use it rather than re-resolving the file, which fails closed until moderation completes. */
  fileUrl: z.string().optional(),
  saveSkippedReason: audioSaveSkippedReasonSchema.optional(),
};

/**
 * The `encoding: 'base64'` body, extended with an endpoint's own fields: the audio
 * inline, or - when it exceeds the serverless response ceiling - a time-limited
 * signed `url` for it. `delivery` is optional on the inline variant only so a
 * client still parses a TTS server that predates the `url` variant; servers always
 * send it.
 */
export function extendGeneratedAudioResponseSchema<Shape extends z.ZodRawShape>(endpointFields: Shape) {
  const common = z.object({ contentType: z.string(), ...generatedAudioSaveFields, ...endpointFields });
  const url = common.extend({
    delivery: z.literal('url'),
    url: z.string(),
    /** Size of the audio behind `url`, in bytes. */
    bytes: z.number().int().nonnegative(),
  });
  const inline = common.extend({
    delivery: z.literal('inline').optional(),
    /** Base64-encoded audio payload. */
    audio: z.string(),
  });
  return z.union([url, inline]);
}

/** The JSON body of an endpoint with no fields of its own (music, sound effects). */
export const generatedAudioResponseSchema = extendGeneratedAudioResponseSchema({});

export type GeneratedAudioResponse = z.infer<typeof generatedAudioResponseSchema>;

/**
 * 413 body: the audio was generated and billed, exceeds the response ceiling, and
 * offloading it to storage failed too. Written, never thrown, so it carries no
 * `name`/`request_id`.
 */
export const generatedAudioTooLargeSchema = z.object({ error: z.string() });

/** Key prefix for oversized generated audio staged for download. Reaped by the bucket lifecycle rules, so reserved from user-chosen FabFile prefixes. */
export const GENERATED_AUDIO_OFFLOAD_PREFIX = 'generated-audio-offload/';
