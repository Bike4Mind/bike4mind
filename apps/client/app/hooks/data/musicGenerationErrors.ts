import { isAxiosError } from 'axios';
import {
  MUSIC_GENERATION_API_ERROR_CODES,
  parseStorageLimitErrorInfo,
  type MusicGenerationApiErrorCode,
} from '@bike4mind/common';
import { describeGenerationError } from './generationErrors';

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
  // Sent only by the cancel route, for a song the provider is already composing (billed whatever happens).
  not_cancellable: "This song is already being composed and can't be cancelled.",
};

// Storage is checked before the provider is paid; the route answers with the shared StorageLimitError (a 400).
const STORAGE_FULL_MESSAGE = 'Your file storage is full. Free up space in Files, then try again.';

// The cancel hook uses this to refetch the card; the toast text comes from MESSAGES like any other code.
export const isMusicNotCancellableError = (error: unknown): boolean => {
  if (!isAxiosError(error) || error.response?.status !== 409) return false;
  const data: unknown = error.response.data;
  return typeof data === 'object' && data !== null && 'errorCode' in data && data.errorCode === 'not_cancellable';
};

export function describeMusicCancelError(error: unknown): string {
  return describeMusicGenerationError(error, 'Could not cancel the song. Try again.');
}

export function describeMusicGenerationError(error: unknown, fallback: string): string {
  // Only music has a storage quota to report; a rate limit still wins over it.
  if (isAxiosError(error) && error.response?.status !== 429 && parseStorageLimitErrorInfo(error.response?.data)) {
    return STORAGE_FULL_MESSAGE;
  }
  return describeGenerationError(MUSIC_GENERATION_API_ERROR_CODES, MESSAGES, error, fallback);
}
