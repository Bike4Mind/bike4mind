import { VIDEO_GENERATION_API_ERROR_CODES } from '@bike4mind/common';
import type { PayerAccount } from './generationBillingTarget';
import { describeGenerationError } from './generationErrors';

type VideoGenerationApiErrorCode = (typeof VIDEO_GENERATION_API_ERROR_CODES)[number];

// Keyed by the API's errorCode (b4m-core/common/src/schemas/videoGenerations.ts). The response's `error` text is
// never shown: user-facing messages come from the code (spec section 8).
const MESSAGES: Record<VideoGenerationApiErrorCode, string> = {
  unsupported_duration: 'This model does not support that duration.',
  unsupported_aspect_ratio: 'This model does not support that aspect ratio.',
  unsupported_resolution: 'This model does not support that resolution.',
  unsupported_mode: 'This model does not support that mode.',
  missing_input_image: 'Choose an image to animate.',
  unexpected_input_image: 'Remove the image, or switch to image to video.',
  unsupported_input_role: 'This model does not take that kind of image, or not that many. Remove one.',
  unsupported_audio_option: 'This model does not let you turn audio on or off.',
  invalid_request: 'The request was not valid. Check the form and try again.',
  model_disabled: 'This model has been turned off. Pick another model.',
  model_unavailable: 'This model is not available right now. Pick another model.',
  insufficient_credits: 'You do not have enough credits for this video.',
  input_image_not_found: 'The selected image was not found. Pick another image.',
  idempotency_key_reused: 'This request was already sent with different settings. Try again.',
  invalid_idempotency_key: 'The request could not be sent. Try again.',
};

export function describeVideoGenerationError(
  error: unknown,
  fallback: string,
  billingAccount?: PayerAccount | null
): string {
  return describeGenerationError(
    VIDEO_GENERATION_API_ERROR_CODES,
    MESSAGES,
    error,
    fallback,
    billingAccount === undefined ? undefined : { noun: 'video', billingAccount }
  );
}
