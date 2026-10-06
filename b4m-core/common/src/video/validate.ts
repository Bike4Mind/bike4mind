import type { VideoGenerationRequest, ValidatedVideoRequest } from './request';
import type { DurationCapability, VideoModelCapabilities } from './types';

export const VIDEO_VALIDATION_ERROR_CODES = [
  'unsupported_duration',
  'unsupported_aspect_ratio',
  'unsupported_resolution',
  'unsupported_mode',
  'missing_input_image',
  'unexpected_input_image',
  'unsupported_audio_option',
] as const;
export type VideoValidationErrorCode = (typeof VIDEO_VALIDATION_ERROR_CODES)[number];

export type VideoValidationResult =
  { ok: true; request: ValidatedVideoRequest } | { ok: false; code: VideoValidationErrorCode; message: string };

const fail = (code: VideoValidationErrorCode, message: string): VideoValidationResult => ({ ok: false, code, message });

const isDurationAllowed = (seconds: number, duration: DurationCapability): boolean => {
  if (duration.kind === 'discrete') return duration.values.includes(seconds);
  if (seconds < duration.min || seconds > duration.max) return false;
  // Float-safe step check: 3.5 on a step-1 range is rejected, 4 is accepted.
  const stepsFromMin = (seconds - duration.min) / duration.step;
  return Math.abs(stepsFromMin - Math.round(stepsFromMin)) < 1e-9;
};

const describeDuration = (duration: DurationCapability): string =>
  duration.kind === 'discrete'
    ? `allowed: ${duration.values.join(', ')}s`
    : `allowed: ${duration.min}-${duration.max}s in ${duration.step}s steps`;

// Never rounds or clamps: a request the model cannot honour fails with a code the caller can surface.
export const validateAgainstCapabilities = (
  request: VideoGenerationRequest,
  caps: VideoModelCapabilities
): VideoValidationResult => {
  if (!caps.modes.includes(request.mode)) {
    return fail('unsupported_mode', `${caps.displayName} does not support ${request.mode}`);
  }
  if (request.mode === 'image_to_video' && !request.inputImageFileId) {
    return fail('missing_input_image', 'image_to_video requires inputImageFileId');
  }
  if (request.mode === 'text_to_video' && request.inputImageFileId) {
    return fail('unexpected_input_image', 'inputImageFileId is only valid for image_to_video');
  }
  if (!isDurationAllowed(request.durationSeconds, caps.duration)) {
    return fail(
      'unsupported_duration',
      `duration ${request.durationSeconds}s is not supported by ${caps.displayName} (${describeDuration(caps.duration)})`
    );
  }
  if (!caps.aspectRatios.includes(request.aspectRatio)) {
    return fail(
      'unsupported_aspect_ratio',
      `aspect ratio ${request.aspectRatio} is not supported by ${caps.displayName} (allowed: ${caps.aspectRatios.join(', ')})`
    );
  }
  if (!caps.resolutions.includes(request.resolution)) {
    return fail(
      'unsupported_resolution',
      `resolution ${request.resolution} is not supported by ${caps.displayName} (allowed: ${caps.resolutions.join(', ')})`
    );
  }
  if (request.audio !== undefined && caps.audio !== 'optional') {
    return fail('unsupported_audio_option', `${caps.displayName} audio is '${caps.audio}' and cannot be toggled`);
  }
  return { ok: true, request: request as ValidatedVideoRequest };
};
