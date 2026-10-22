import {
  usdToCredits,
  VIDEO_INPUT_ROLES,
  VIDEO_MODEL_CATALOG,
  type VideoModel,
  type VideoModelId,
} from '@bike4mind/common';

/** The server's public shape for a catalog model, as toPublicVideoModel renders it. */
export function publicVideoModel(id: VideoModelId): VideoModel {
  const caps = VIDEO_MODEL_CATALOG[id];
  return {
    id,
    object: 'video_model',
    display_name: caps.displayName,
    provider: caps.provider,
    modes: [...caps.modes],
    input_roles: VIDEO_INPUT_ROLES.flatMap(role => {
      const accepted = caps.inputs[role];
      return accepted ? [{ role, max: accepted.max }] : [];
    }),
    duration:
      caps.duration.kind === 'range'
        ? { kind: 'range', min: caps.duration.min, max: caps.duration.max, step: caps.duration.step }
        : { kind: 'discrete', values: [...caps.duration.values] },
    aspect_ratios: [...caps.aspectRatios],
    resolutions: [...caps.resolutions],
    defaults: {
      duration_seconds: caps.defaults.durationSeconds,
      aspect_ratio: caps.defaults.aspectRatio,
      resolution: caps.defaults.resolution,
    },
    audio: caps.audio,
    credits_per_second:
      caps.pricing.unit === 'per_second'
        ? Object.fromEntries(
            Object.entries(caps.pricing.usdByResolution).map(([tier, usd]) => [tier, usdToCredits(usd ?? 0)])
          )
        : null,
    deprecation_date: null,
  };
}
