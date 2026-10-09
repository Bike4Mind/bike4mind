import { insufficientCreditsError, type ApiErrorCode } from '@bike4mind/common';
import { HTTPError, NotFoundError, UnauthorizedError, UnprocessableEntityError } from '@server/utils/errors';
import { TranscribeRequestError } from './transcribe';

/**
 * Maps a transcribe helper rejection (a 400 on the SPA routes) onto the CONVENTIONS.md status table
 * for the /api/v1/transcriptions routes. Anything else passes through unchanged.
 */
export function toPublicTranscribeError(err: unknown): unknown {
  if (!(err instanceof TranscribeRequestError)) return err;
  switch (err.kind) {
    case 'invalid_key':
    case 'not_found':
      return new NotFoundError('Upload not found or expired');
    case 'unsupported_type':
    case 'size_out_of_range':
      return new UnprocessableEntityError(err.message);
    case 'insufficient_credits':
      return insufficientCreditsError(err.message);
    case 'not_configured':
      return new HTTPError(503, err.message, { errorCode: 'provider_not_configured' satisfies ApiErrorCode });
    case 'user_not_found':
      return new UnauthorizedError(err.message);
  }
}
