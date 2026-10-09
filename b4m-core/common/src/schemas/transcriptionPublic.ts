import { z } from 'zod';

/**
 * Wire schemas for the public `/api/v1/transcriptions` contracts
 * (api-contract/contracts/transcription.contract.ts): mint an upload, then transcribe it.
 *
 * Imported directly (never through the schemas barrel) by the contract and OpenAPI layers, so keep
 * this file free of `@bike4mind/*` imports - the CI spec job loads it without building anything.
 */

// Must stay in sync with ALLOWED_AUDIO_MIME_TYPES and MAX_TRANSCRIBE_BYTES in
// b4m-core/services/src/speech/constants.ts, which common cannot import. Pinned equal by
// apps/client/server/transcribe/transcriptionConstants.test.ts.
export const TRANSCRIPTION_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'audio/flac',
] as const;
export const TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

export const CreateTranscriptionUploadRequestSchema = z
  .object({
    mime_type: z.enum(TRANSCRIPTION_MIME_TYPES),
    file_size: z
      .number()
      .int()
      .min(1)
      .max(TRANSCRIPTION_MAX_BYTES)
      .describe('Size in bytes of the audio you will upload. At most 25 MiB.'),
  })
  .strict();
export type CreateTranscriptionUploadRequest = z.infer<typeof CreateTranscriptionUploadRequestSchema>;

export const TranscriptionUploadResponseSchema = z.object({
  upload_url: z.string().describe('POST the audio here as `multipart/form-data`. Send no `Authorization` header.'),
  upload_fields: z
    .record(z.string(), z.string())
    .describe('Form fields to send, unchanged and before the `file` field, with the upload.'),
  file_key: z.string().describe('Pass this to `POST /api/v1/transcriptions` once the upload succeeds.'),
  expires_at: z.string().describe('ISO 8601. The upload is refused after this; mint a new one to retry.'),
});
export type TranscriptionUploadResponse = z.infer<typeof TranscriptionUploadResponseSchema>;

export const CreateTranscriptionRequestSchema = z
  .object({
    file_key: z.string().min(1).describe('The `file_key` from `POST /api/v1/transcriptions/uploads`.'),
  })
  .strict();
export type CreateTranscriptionRequest = z.infer<typeof CreateTranscriptionRequestSchema>;

export const TranscriptionResponseSchema = z.object({
  text: z.string(),
});
export type TranscriptionResponse = z.infer<typeof TranscriptionResponseSchema>;
