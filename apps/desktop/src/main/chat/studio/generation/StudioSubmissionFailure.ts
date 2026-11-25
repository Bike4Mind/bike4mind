import {
  IMAGE_JOB_API_ERROR_CODES,
  MUSIC_VALIDATION_ERROR_CODES,
  VIDEO_VALIDATION_ERROR_CODES,
} from '@bike4mind/common';
import { toMediaError } from '../../media/MediaApiClient';
import type { StudioGenerationRequest } from './StudioGenerationService';

// POST /api/v1/image-jobs refuses before admission with 422 (credits included, no 402), 400 for a contract or
// storage failure. idempotency_key_reused stays unknown: an earlier request with that key may have been billed.
const imageRefusals: Readonly<Record<number, ReadonlySet<string>>> = {
  400: new Set(['invalid_request', 'storage_limit_exceeded', 'org_storage_limit_exceeded']),
  422: new Set<string>(
    IMAGE_JOB_API_ERROR_CODES.filter(
      code => code !== 'idempotency_key_reused' && code !== 'invalid_idempotency_key' && code !== 'not_cancellable'
    )
  ),
};
const commonRefusals = [
  'invalid_request',
  'model_disabled',
  'model_unavailable',
  'insufficient_credits',
  'input_image_not_found',
];
const videoRefusals = new Set([...commonRefusals, ...VIDEO_VALIDATION_ERROR_CODES]);
const musicRefusals = new Set([...commonRefusals, ...MUSIC_VALIDATION_ERROR_CODES]);

/** Only endpoint contracts that reject before admission can settle a local failure. */
export function studioSubmissionFailure(error: unknown, request: StudioGenerationRequest) {
  const failure = toMediaError(error, 'Generation');
  const { status, code } = failure;
  let refused = failure.requestNotStarted === true;
  if (code && status) {
    if (request.kind === 'image') refused ||= imageRefusals[status]?.has(code) ?? false;
    if (request.kind === 'video')
      refused ||= (status === 422 && videoRefusals.has(code)) || (status === 404 && code === 'input_image_not_found');
    if (request.kind === 'music') refused ||= status === 422 && musicRefusals.has(code);
    if (request.kind === 'speech')
      refused ||=
        (status === 422 && code === 'insufficient_credits') || (status === 401 && code === 'provider_not_configured');
  }
  return { state: refused ? ('failed' as const) : ('unknown' as const), error: failure.message, errorCode: code };
}
