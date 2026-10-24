import { TooManyRequestsError } from '@bike4mind/common';
import type { ProviderBusyError } from '@bike4mind/services';

/** A provider at capacity is "try again shortly" for the caller: 429 with `Retry-After`, never a 5xx. */
export const providerBusyHttpError = (error: ProviderBusyError) =>
  new TooManyRequestsError('The generation service is busy. Please try again in a moment.', {
    retryAfter: error.retryAfterSeconds,
  });
