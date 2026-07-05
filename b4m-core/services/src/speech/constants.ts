/**
 * Shared transcription constants. Defined here (rather than in the client app)
 * so the allowlist and the AWS MediaFormat map can share a compile-time-checked
 * type: adding a mime type to the allowlist becomes a type error in any
 * Record<AllowedAudioMimeType, ...> until the new entry is filled in.
 */

export const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'audio/flac',
] as const;

export type AllowedAudioMimeType = (typeof ALLOWED_AUDIO_MIME_TYPES)[number];

// Matches the OpenAI Whisper hard limit (25 MB). AWS Transcribe allows more
// but we cap at the lowest common denominator since the operations-model
// can switch backends at any time.
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
