import { MUSIC_VALIDATION_ERROR_CODES, VIDEO_VALIDATION_ERROR_CODES } from '@bike4mind/common';
import { toMediaError } from '../../media/MediaApiClient';
import type { StudioGenerationRequest } from './StudioGenerationService';

const imageRefusals: Readonly<Record<number, ReadonlySet<string>>> = {
  400: new Set(['invalid_request', 'invalid_count', 'storage_quota_exceeded']),
  402: new Set(['insufficient_credits']),
  403: new Set(['FEATURE_DISABLED']),
  422: new Set(['model_unavailable', 'unsupported_by_model', 'input_image_not_found', 'unsupported_input_image']),
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
    if (request.kind === 'image' && 'mode' in request.body) refused ||= imageRefusals[status]?.has(code) ?? false;
    if (request.kind === 'video')
      refused ||= (status === 422 && videoRefusals.has(code)) || (status === 404 && code === 'input_image_not_found');
    if (request.kind === 'music') refused ||= status === 422 && musicRefusals.has(code);
    if (request.kind === 'speech')
      refused ||=
        (status === 422 && code === 'insufficient_credits') || (status === 401 && code === 'provider_not_configured');
  }
  return { state: refused ? ('failed' as const) : ('unknown' as const), error: failure.message, errorCode: code };
}
