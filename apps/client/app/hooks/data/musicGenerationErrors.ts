import { isAxiosError } from 'axios';
import {
  MUSIC_GENERATION_API_ERROR_CODES,
  parseStorageLimitErrorInfo,
  type MusicGenerationApiErrorCode,
} from '@bike4mind/common';
import { GENERATION_RATE_LIMITED_MESSAGE } from './videoGenerationErrors';

// Keyed by the API's errorCode (b4m-core/common/src/schemas/musicGenerations.ts). As with video, the response's
// `error` text is never shown: user-facing messages come from the code.
const MESSAGES: Record<MusicGenerationApiErrorCode, string> = {
  unsupported_duration: 'This model does not support that duration.',
  unsupported_lyrics: 'This model does not accept custom lyrics.',
  unsupported_vocals: 'This model only makes instrumental music.',
  lyrics_with_instrumental: 'Remove the lyrics, or turn off Instrumental.',
  lyrics_too_long: 'The lyrics are too long for this model.',
  invalid_request: 'The request was not valid. Check the form and try again.',
  model_disabled: 'This model has been turned off. Pick another model.',
  model_unavailable: 'This model is not available right now. Pick another model.',
  insufficient_credits: 'You do not have enough credits for this song.',
  idempotency_key_reused: 'This request was already sent with different settings. Try again.',
  invalid_idempotency_key: 'The request could not be sent. Try again.',
};

// Storage is checked before the provider is paid; the route answers with the shared StorageLimitError (a 400).
const STORAGE_FULL_MESSAGE = 'Your file storage is full. Free up space in Files, then try again.';

const isMusicApiErrorCode = (value: unknown): value is MusicGenerationApiErrorCode =>
  typeof value === 'string' && (MUSIC_GENERATION_API_ERROR_CODES as readonly string[]).includes(value);

const readErrorCode = (data: unknown): unknown =>
  typeof data === 'object' && data !== null && 'errorCode' in data ? data.errorCode : undefined;

export function describeMusicGenerationError(error: unknown, fallback: string): string {
  if (!isAxiosError(error)) return fallback;
  if (error.response?.status === 429) return GENERATION_RATE_LIMITED_MESSAGE;
  const data: unknown = error.response?.data;
  const code = readErrorCode(data);
  if (isMusicApiErrorCode(code)) return MESSAGES[code];
  return parseStorageLimitErrorInfo(data) ? STORAGE_FULL_MESSAGE : fallback;
}
