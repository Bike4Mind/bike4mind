import { usdToCredits } from '../pricing';
import type { VideoGenerationRequest } from './request';
import type { VideoModelCapabilities } from './types';
import { validateAgainstCapabilities } from './validate';

export const estimateVideoCostUsd = (caps: VideoModelCapabilities, request: VideoGenerationRequest): number => {
  const { pricing } = caps;
  if (pricing.unit === 'per_second') {
    const rate = pricing.usdByResolution[request.resolution];
    if (rate === undefined) {
      throw new Error(`${caps.displayName}: no per_second price for ${request.resolution}`);
    }
    return rate * request.durationSeconds;
  }
  const clip = pricing.clips.find(
    c => c.durationSeconds === request.durationSeconds && c.resolution === request.resolution
  );
  if (!clip) {
    throw new Error(`${caps.displayName}: no per_clip price for ${request.durationSeconds}s at ${request.resolution}`);
  }
  return clip.usd;
};

// Shared by the studio (display) and the server (credit hold) so the two can never drift.
export const estimateVideoCostCredits = (caps: VideoModelCapabilities, request: VideoGenerationRequest): number =>
  usdToCredits(estimateVideoCostUsd(caps, request));

/**
 * The request a finished clip is billed on: the provider-reported duration when the model could have been asked for
 * it, otherwise the requested one. A reported 8.04s has no per-clip price, and billing must not fail on rounding.
 */
export const billedVideoRequest = (
  caps: VideoModelCapabilities,
  request: VideoGenerationRequest,
  reportedDurationSeconds: number | undefined
): VideoGenerationRequest => {
  if (reportedDurationSeconds === undefined) return request;
  const reported = { ...request, durationSeconds: reportedDurationSeconds };
  return validateAgainstCapabilities(reported, caps).ok ? reported : request;
};
