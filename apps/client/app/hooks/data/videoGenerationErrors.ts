import { isAxiosError } from 'axios';
import { VIDEO_GENERATION_API_ERROR_CODES } from '@bike4mind/common';

type VideoGenerationApiErrorCode = (typeof VIDEO_GENERATION_API_ERROR_CODES)[number];

export const VIDEO_RATE_LIMITED_MESSAGE = 'Too many requests. Wait a moment and try again.';

// Keyed by the API's errorCode (b4m-core/common/src/schemas/videoGenerations.ts). The response's `error` text is
// never shown: user-facing messages come from the code (spec section 8).
const MESSAGES: Record<VideoGenerationApiErrorCode, string> = {
  unsupported_duration: 'This model does not support that duration.',
  unsupported_aspect_ratio: 'This model does not support that aspect ratio.',
  unsupported_resolution: 'This model does not support that resolution.',
  unsupported_mode: 'This model does not support that mode.',
  missing_input_image: 'Choose an image to animate.',
  unexpected_input_image: 'Remove the image, or switch to image to video.',
  unsupported_audio_option: 'This model does not let you turn audio on or off.',
  invalid_request: 'The request was not valid. Check the form and try again.',
  model_disabled: 'This model has been turned off. Pick another model.',
  model_unavailable: 'This model is not available right now. Pick another model.',
  insufficient_credits: 'You do not have enough credits for this video.',
  input_image_not_found: 'The selected image was not found. Pick another image.',
  idempotency_key_reused: 'This request was already sent with different settings. Try again.',
  invalid_idempotency_key: 'The request could not be sent. Try again.',
};

const isVideoApiErrorCode = (value: unknown): value is VideoGenerationApiErrorCode =>
  typeof value === 'string' && (VIDEO_GENERATION_API_ERROR_CODES as readonly string[]).includes(value);

const readErrorCode = (data: unknown): unknown =>
  typeof data === 'object' && data !== null && 'errorCode' in data ? data.errorCode : undefined;

export function describeVideoGenerationError(error: unknown, fallback: string): string {
  if (!isAxiosError(error)) return fallback;
  if (error.response?.status === 429) return VIDEO_RATE_LIMITED_MESSAGE;
  const code = readErrorCode(error.response?.data);
  return isVideoApiErrorCode(code) ? MESSAGES[code] : fallback;
}
